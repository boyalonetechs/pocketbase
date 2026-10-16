package apis

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	validation "github.com/pocketbase/ozzo-validation/v4"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

const (
	sqlEditorMaxQueryLength = 5000
	sqlEditorMaxRows        = 1000
	sqlEditorMaxTimeout     = 3 * time.Minute
)

var editorKnownWriteQueryPrefixes = []string{
	"INSERT", "CREATE", "UPDATE", "DELETE",
	"DROP", "DETACH", "ALTER", "REPLACE",
}

var (
	createTableRegex = regexp.MustCompile(`(?is)^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.*)\)\s*;?\s*$`)
	dropTableRegex   = regexp.MustCompile(`(?is)^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)\s*;?\s*$`)
	addColumnRegex   = regexp.MustCompile(`(?is)^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(.+?)\s*;?\s*$`)
	dropColumnRegex  = regexp.MustCompile(`(?is)^\s*ALTER\s+TABLE\s+(\w+)\s+DROP\s+(?:COLUMN\s+)?(\w+)\s*;?\s*$`)

	// matches a "simple" select: SELECT <columns> FROM <table> [rest] [;]
	simpleSelectRegex = regexp.MustCompile("(?is)^\\s*SELECT\\s+(.+?)\\s+FROM\\s+([`\"\\[\\]]?[A-Za-z_][A-Za-z0-9_]*[`\"\\[\\]]?)(\\s+.*?)?\\s*;?\\s*$")
	selectIdRegex     = regexp.MustCompile(`(?i)\bid\b`)
)

// bindSQLEditorApi registers the SQL Editor api endpoints.
func bindSQLEditorApi(app core.App, rg *router.RouterGroup[*core.RequestEvent]) {
	subGroup := rg.Group("/sql-editor").Bind(RequireSuperuserAuth())
	subGroup.POST("", runSQLEditor)
}

func runSQLEditor(e *core.RequestEvent) error {
	if !e.HasSuperuserAuth() {
		return e.ForbiddenError("", nil)
	}

	form := sqLEditorForm{}

	err := e.BindBody(&form)
	if err != nil {
		return firstApiError(err, e.BadRequestError("An error occurred while loading the submitted data.", err))
	}

	err = form.validate()
	if err != nil {
		return firstApiError(err, e.BadRequestError("An error occurred while validating the submitted data.", err))
	}

	result, err := executeSQLEditor(e.App, form.Query)
	if err != nil {
		return firstApiError(err, e.BadRequestError("Failed to execute SQL. Raw error:\n"+err.Error(), nil))
	}

	return e.JSON(http.StatusOK, result)
}

type sqLEditorForm struct {
	Query string `form:"query" json:"query"`
}

func (form *sqLEditorForm) validate() error {
	return validation.ValidateStruct(form,
		validation.Field(&form.Query, validation.Required, validation.Length(0, sqlEditorMaxQueryLength)),
	)
}

type sqLEditorResultColumn struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
}

type sqLEditorResult struct {
	ExecTime     int64                   `json:"execTime"`
	AffectedRows int64                   `json:"affectedRows"`
	Columns      []sqLEditorResultColumn `json:"columns"`
	Rows         [][]any                 `json:"rows"`
	Success      bool                    `json:"success"`
	Message      string                  `json:"message,omitempty"`
	Collection   string                  `json:"collection,omitempty"`
	FieldsAdded  int                     `json:"fieldsAdded,omitempty"`
}

func executeSQLEditor(app core.App, query string) (*sqLEditorResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errors.New("empty query")
	}

	// CREATE TABLE is translated into a native PocketBase collection
	// so that it is visible in the admin UI and REST API.
	if matches := createTableRegex.FindStringSubmatch(query); matches != nil && len(matches) >= 3 {
		return executeCreateTable(app, matches[1], matches[2])
	}

	// DROP TABLE removes the native collection when it exists to keep
	// the collection cache in sync, otherwise it is executed as raw SQL.
	if matches := dropTableRegex.FindStringSubmatch(query); matches != nil && len(matches) >= 2 {
		return executeDropTable(app, matches[1])
	}

	// ALTER TABLE ADD/DROP COLUMN is translated into the native collection
	// field editor so that PocketBase specific field types/options are preserved.
	if matches := dropColumnRegex.FindStringSubmatch(query); matches != nil && len(matches) >= 3 {
		return executeDropColumn(app, matches[1], matches[2])
	}

	if matches := addColumnRegex.FindStringSubmatch(query); matches != nil && len(matches) >= 3 {
		return executeAddColumn(app, matches[1], matches[2])
	}

	return executeRawQuery(app, query)
}

// injectRecordIdForFileFields rewrites a simple "SELECT <cols> FROM <collection>"
// query to also include the "id" column when one of the selected columns is a
// file field. This allows the SQL Editor UI to resolve and preview the file
// thumbnails even when the user didn't explicitly select the id column.
func injectRecordIdForFileFields(app core.App, original string) string {
	matches := simpleSelectRegex.FindStringSubmatch(original)
	if matches == nil {
		return original
	}

	tableName := strings.Trim(strings.TrimSpace(matches[2]), "`\"'[]")

	collection, err := app.FindCollectionByNameOrId(tableName)
	if err != nil || collection == nil {
		return original
	}

	fileFieldNames := map[string]struct{}{}
	for _, f := range collection.Fields {
		if f.Type() == core.FieldTypeFile {
			fileFieldNames[strings.ToLower(f.GetName())] = struct{}{}
		}
	}

	return rewriteSelectToIncludeId(original, fileFieldNames)
}

// rewriteSelectToIncludeId prepends the "id" column to a simple select query
// when at least one of the selected columns is a file field. It is a no-op for
// star/aggregate/grouped/joined selects or when the id is already selected or
// none of the selected columns is a known file field.
func rewriteSelectToIncludeId(original string, fileFieldNames map[string]struct{}) string {
	if len(fileFieldNames) == 0 {
		return original
	}

	matches := simpleSelectRegex.FindStringSubmatch(original)
	if matches == nil {
		return original
	}

	selectList := strings.TrimSpace(matches[1])
	tableName := strings.Trim(strings.TrimSpace(matches[2]), "`\"'[]")
	rest := strings.ToUpper(matches[3])

	// skip star/aggregate selects or selects that already contain the id
	if selectList == "" ||
		strings.Contains(selectList, "*") ||
		strings.Contains(selectList, "(") ||
		selectIdRegex.MatchString(selectList) {
		return original
	}

	// skip grouped/joined/combined selects where an extra id would change the result
	for _, kw := range []string{" JOIN ", " GROUP ", " UNION ", " DISTINCT ", " HAVING ", " INTERSECT ", " EXCEPT "} {
		if strings.Contains(rest, kw) {
			return original
		}
	}

	// only inject when at least one selected column refers to a file field
	hasFileColumn := false
	for _, raw := range splitColumns(selectList) {
		name := normalizeSelectColumn(raw)
		if _, ok := fileFieldNames[name]; ok {
			hasFileColumn = true
			break
		}
	}
	if !hasFileColumn {
		return original
	}

	return "SELECT id, " + selectList + " FROM " + tableName + matches[3]
}

// normalizeSelectColumn returns the plain lowercased column name of a select
// expression, stripping any "table." prefix and "AS alias" suffix.
func normalizeSelectColumn(raw string) string {
	raw = strings.TrimSpace(raw)

	if asPos := regexp.MustCompile(`(?i)\s+as\s+`).FindStringIndex(raw); asPos != nil {
		raw = raw[:asPos[0]]
	} else if parts := strings.Fields(raw); len(parts) > 1 {
		raw = parts[0]
	}

	if dotPos := strings.LastIndex(raw, "."); dotPos >= 0 {
		raw = raw[dotPos+1:]
	}

	return strings.ToLower(strings.Trim(strings.TrimSpace(raw), "`\"'[]"))
}

func executeRawQuery(app core.App, query string) (*sqLEditorResult, error) {
	var isPossibleWriteQuery bool

	// ensure simple selects on collections with file fields also return the
	// record "id" so that the UI can resolve and preview the file thumbnails
	// (without requiring the user to explicitly select the id column).
	query = injectRecordIdForFileFields(app, query)

	ucQuery := strings.ToUpper(query)
	if !strings.HasPrefix(ucQuery, "SELECT") {
		for _, prefix := range editorKnownWriteQueryPrefixes {
			if strings.HasPrefix(ucQuery, prefix) {
				isPossibleWriteQuery = true
				break
			}
		}
	}

	ctx, cancelFunc := context.WithTimeout(context.Background(), sqlEditorMaxTimeout)
	defer cancelFunc()

	result := &sqLEditorResult{
		Columns: []sqLEditorResultColumn{},
		Rows:    [][]any{},
		Success: true,
	}

	now := time.Now()
	defer func() {
		result.ExecTime = time.Since(now).Milliseconds()
	}()

	if isPossibleWriteQuery {
		txErr := app.RunInTransaction(func(txApp core.App) error {
			execResult, err := txApp.NonconcurrentDB().NewQuery(query).WithContext(ctx).Execute()
			if err != nil {
				return err
			}

			result.AffectedRows, err = execResult.RowsAffected()
			if err != nil {
				txApp.Logger().Debug("Unable to fetch affected rows", "error", err.Error())
			}

			result.Message = "Query executed successfully"
			return nil
		})
		if txErr != nil {
			return nil, txErr
		}

		return result, nil
	}

	rows, err := app.ConcurrentDB().NewQuery(query).WithContext(ctx).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	colTypes, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}

	for _, colType := range colTypes {
		col := sqLEditorResultColumn{
			Name: colType.Name(),
			Type: colType.DatabaseTypeName(),
		}
		col.Nullable, _ = colType.Nullable()

		result.Columns = append(result.Columns, col)
	}

	for rows.Next() {
		if len(result.Rows) >= sqlEditorMaxRows {
			break
		}

		rowData := make([]any, len(colTypes))
		for i := 0; i < len(colTypes); i++ {
			var v *string
			rowData[i] = &v
		}

		err := rows.Scan(rowData...)
		if err != nil {
			return nil, err
		}

		result.Rows = append(result.Rows, rowData)
	}

	err = rows.Err()
	if err != nil {
		return nil, err
	}

	result.Message = "Query executed successfully"
	return result, nil
}

type parsedColumn struct {
	Name    string
	Type    string
	Args    string
	NotNull bool
	Primary bool
}

func executeCreateTable(app core.App, tableName, columnsStr string) (*sqLEditorResult, error) {
	if tableName == "" {
		return nil, errors.New("missing table name")
	}

	existing, err := app.FindCollectionByNameOrId(tableName)
	if err == nil && existing != nil {
		return nil, fmt.Errorf("collection %q already exists", tableName)
	}

	collection := core.NewBaseCollection(tableName)

	columns := parseColumns(columnsStr)
	fieldsAdded := 0

	for _, col := range columns {
		if isSystemField(col.Name) {
			continue
		}

		field, err := createFieldFromColumn(app, col)
		if err != nil {
			return nil, err
		}

		if field != nil {
			collection.Fields.Add(field)
			fieldsAdded++
		}
	}

	if err := app.Save(collection); err != nil {
		return nil, err
	}

	return &sqLEditorResult{
		Message:      fmt.Sprintf("Successfully created collection %q with %d fields", tableName, fieldsAdded),
		Collection:   tableName,
		FieldsAdded:  fieldsAdded,
		Success:      true,
		AffectedRows: 0,
		Columns:      []sqLEditorResultColumn{},
		Rows:         [][]any{},
		ExecTime:     0,
	}, nil
}

func executeAddColumn(app core.App, tableName, columnDef string) (*sqLEditorResult, error) {
	collection, err := app.FindCollectionByNameOrId(tableName)
	if err != nil || collection == nil {
		return nil, fmt.Errorf("collection %q not found", tableName)
	}

	col := parseColumn(columnDef)
	if col == nil {
		return nil, fmt.Errorf("invalid column definition %q", columnDef)
	}

	if collection.Fields.GetByName(col.Name) != nil {
		return nil, fmt.Errorf("field %q already exists in collection %q", col.Name, tableName)
	}

	field, err := createFieldFromColumn(app, *col)
	if err != nil {
		return nil, err
	}

	collection.Fields.Add(field)

	if err := app.Save(collection); err != nil {
		return nil, err
	}

	return &sqLEditorResult{
		Message:      fmt.Sprintf("Successfully added field %q to collection %q", col.Name, tableName),
		Collection:   tableName,
		FieldsAdded:  1,
		Success:      true,
		AffectedRows: 0,
		Columns:      []sqLEditorResultColumn{},
		Rows:         [][]any{},
		ExecTime:     0,
	}, nil
}

func executeDropColumn(app core.App, tableName, columnName string) (*sqLEditorResult, error) {
	collection, err := app.FindCollectionByNameOrId(tableName)
	if err != nil || collection == nil {
		// not a native collection, fall back to the SQLite ALTER TABLE
		return executeRawQuery(app, fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s", tableName, columnName))
	}

	if isSystemField(columnName) {
		return nil, fmt.Errorf("system field %q cannot be removed", columnName)
	}

	if collection.Fields.GetByName(columnName) == nil {
		return nil, fmt.Errorf("field %q not found in collection %q", columnName, tableName)
	}

	collection.Fields.RemoveByName(columnName)

	if err := app.Save(collection); err != nil {
		return nil, err
	}

	return &sqLEditorResult{
		Message:      fmt.Sprintf("Successfully removed field %q from collection %q", columnName, tableName),
		Collection:   tableName,
		Success:      true,
		AffectedRows: 0,
		Columns:      []sqLEditorResultColumn{},
		Rows:         [][]any{},
		ExecTime:     0,
	}, nil
}

func executeDropTable(app core.App, tableName string) (*sqLEditorResult, error) {
	if tableName == "" {
		return nil, errors.New("missing table name")
	}

	collection, err := app.FindCollectionByNameOrId(tableName)
	if err != nil || collection == nil {
		// not a PocketBase collection, execute as raw SQL
		return executeRawQuery(app, "DROP TABLE "+tableName)
	}

	if collection.System {
		return nil, fmt.Errorf("system collection %q cannot be dropped", tableName)
	}

	if err := app.Delete(collection); err != nil {
		return nil, err
	}

	return &sqLEditorResult{
		Message:      fmt.Sprintf("Successfully dropped collection %q", tableName),
		Collection:   tableName,
		Success:      true,
		AffectedRows: 0,
		Columns:      []sqLEditorResultColumn{},
		Rows:         [][]any{},
		ExecTime:     0,
	}, nil
}

func parseColumns(columnsStr string) []parsedColumn {
	var columns []parsedColumn

	parts := splitColumns(columnsStr)

	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		col := parseColumn(part)
		if col != nil {
			columns = append(columns, *col)
		}
	}

	return columns
}

func splitColumns(s string) []string {
	var parts []string
	var current strings.Builder
	parenDepth := 0

	for _, r := range s {
		switch r {
		case '(':
			parenDepth++
			current.WriteRune(r)
		case ')':
			parenDepth--
			current.WriteRune(r)
		case ',':
			if parenDepth == 0 {
				parts = append(parts, current.String())
				current.Reset()
			} else {
				current.WriteRune(r)
			}
		default:
			current.WriteRune(r)
		}
	}

	if current.Len() > 0 {
		parts = append(parts, current.String())
	}

	return parts
}

var columnRegex = regexp.MustCompile(`(?is)^\s*(\w+)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(([^)]*)\))?(.*)$`)

func parseColumn(s string) *parsedColumn {
	s = strings.TrimSpace(s)

	matches := columnRegex.FindStringSubmatch(s)
	if matches == nil {
		return nil
	}

	rest := strings.ToUpper(matches[4])

	return &parsedColumn{
		Name:    strings.ToLower(matches[1]),
		Type:    strings.ToUpper(matches[2]),
		Args:    strings.TrimSpace(matches[3]),
		NotNull: strings.Contains(rest, "NOT NULL") || strings.Contains(rest, "PRIMARY KEY"),
		Primary: strings.Contains(rest, "PRIMARY KEY"),
	}
}

func isSystemField(name string) bool {
	name = strings.ToLower(name)
	return name == "id" || name == "created" || name == "updated"
}

// createFieldFromColumn maps a parsed SQL column definition to a native
// PocketBase field. In addition to the standard SQL types it also understands
// PocketBase specific types (editor, file, relation, select, json, geoPoint,
// autodate, email, url, password) with optional extra args.
func createFieldFromColumn(app core.App, col parsedColumn) (core.Field, error) {
	required := col.NotNull

	switch col.Type {
	case "TEXT", "VARCHAR", "CHAR", "CLOB", "STRING":
		field := &core.TextField{Name: col.Name, Required: required}
		if n := parseFirstInt(col.Args); n > 0 {
			field.Max = n
		}
		return field, nil

	case "INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT":
		return &core.NumberField{Name: col.Name, OnlyInt: true, Required: required}, nil

	case "REAL", "FLOAT", "DOUBLE", "NUMERIC", "DECIMAL":
		return &core.NumberField{Name: col.Name, Required: required}, nil

	case "BOOL", "BOOLEAN":
		return &core.BoolField{Name: col.Name, Required: required}, nil

	case "EMAIL":
		return &core.EmailField{Name: col.Name, Required: required}, nil

	case "URL", "LINK":
		return &core.URLField{Name: col.Name, Required: required}, nil

	case "DATE", "DATETIME", "TIMESTAMP", "TIME":
		return &core.DateField{Name: col.Name, Required: required}, nil

	case "AUTODATE", "CREATED", "UPDATED":
		return &core.AutodateField{Name: col.Name, OnCreate: true}, nil

	case "EDITOR", "RICH", "RICHEDITOR", "HTML":
		return &core.EditorField{Name: col.Name, Required: required}, nil

	case "FILE", "FILES", "BLOB", "BINARY", "VARBINARY":
		return &core.FileField{Name: col.Name, Required: required}, nil

	case "RELATION", "REL", "REF":
		target := parseFirstArg(col.Args)
		if target == "" {
			return nil, fmt.Errorf("relation field %q requires a target collection, e.g. RELATION(users)", col.Name)
		}
		targetCollection, err := app.FindCollectionByNameOrId(target)
		if err != nil || targetCollection == nil {
			return nil, fmt.Errorf("relation target collection %q not found", target)
		}
		return &core.RelationField{
			Name:         col.Name,
			CollectionId: targetCollection.Id,
			MaxSelect:    parseLastInt(col.Args),
			Required:     required,
		}, nil

	case "SELECT", "ENUM":
		values := parseArgsList(col.Args)
		if len(values) == 0 {
			return nil, fmt.Errorf("select field %q requires at least one value, e.g. SELECT(draft,published)", col.Name)
		}
		return &core.SelectField{
			Name:      col.Name,
			Values:    values,
			MaxSelect: 1,
			Required:  required,
		}, nil

	case "JSON":
		return &core.JSONField{Name: col.Name, Required: required}, nil

	case "GEOPOINT", "GEO":
		return &core.GeoPointField{Name: col.Name, Required: required}, nil

	case "PASSWORD":
		return &core.PasswordField{Name: col.Name, Required: required}, nil

	default:
		return &core.TextField{Name: col.Name, Required: required}, nil
	}
}

// parseFirstInt returns the first integer found in args (e.g. "50" or "50,10").
func parseFirstInt(args string) int {
	for _, raw := range strings.Split(args, ",") {
		raw = strings.TrimSpace(strings.Trim(raw, `'"`))
		if n, err := strconv.Atoi(raw); err == nil {
			return n
		}
	}
	return 0
}

// parseLastInt returns the last integer found in args (used for maxSelect).
func parseLastInt(args string) int {
	parts := strings.Split(args, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		raw := strings.TrimSpace(strings.Trim(parts[i], `'"`))
		if n, err := strconv.Atoi(raw); err == nil {
			return n
		}
	}
	return 0
}

// parseFirstArg returns the first non-numeric argument (e.g. the collection name).
func parseFirstArg(args string) string {
	for _, raw := range strings.Split(args, ",") {
		raw = strings.TrimSpace(strings.Trim(raw, `'"`))
		if raw == "" {
			continue
		}
		if _, err := strconv.Atoi(raw); err != nil {
			return raw
		}
	}
	return ""
}

// parseArgsList splits comma separated args, stripping quotes and empties.
func parseArgsList(args string) []string {
	var values []string
	for _, raw := range strings.Split(args, ",") {
		raw = strings.TrimSpace(strings.Trim(raw, `'"`))
		if raw != "" {
			values = append(values, raw)
		}
	}
	return values
}

func init() {
	// Register the SQL Editor API binding
}
