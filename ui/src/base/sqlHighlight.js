// Extends the default Prism SQL grammar with additional token categories
// so that the SQL editor can render SSMS-like colors:
//   - keywords            -> blue
//   - comments            -> dark green
//   - strings/text        -> red
//   - system schemas      -> green  (sys, INFORMATION_SCHEMA)
//   - functions           -> magenta
//   - stored procedures   -> maroon (sp_*, xp_*)
//   - params / variables  -> teal   (@param, @@GLOBAL)
//   - operators           -> dark gray
//   - sqlcmd commands     -> black on silver
//
// The `pbsql` language is used by `app.components.codeEditor({ language: "pbsql" })`.

window.app = window.app || {};

(function() {
    if (typeof Prism == "undefined" || !Prism.languages.sql) {
        return;
    }

    const sql = Prism.languages.sql;

    // broader function list than the default Prism SQL grammar
    const functions = [
        "AVG",
        "COUNT",
        "FIRST",
        "FORMAT",
        "LAST",
        "LCASE",
        "LEN",
        "MAX",
        "MID",
        "MIN",
        "MOD",
        "NOW",
        "ROUND",
        "SUM",
        "UCASE",
        "ABS",
        "CAST",
        "CEILING",
        "CHARINDEX",
        "COALESCE",
        "CONVERT",
        "CURRENT_TIMESTAMP",
        "CURRENT_DATE",
        "DATEADD",
        "DATEDIFF",
        "DATENAME",
        "DATEPART",
        "FLOOR",
        "GETDATE",
        "GETUTCDATE",
        "IFNULL",
        "IIF",
        "ISDATE",
        "ISNULL",
        "ISNUMERIC",
        "LEFT",
        "LOWER",
        "LTRIM",
        "NULLIF",
        "OBJECT_ID",
        "PATINDEX",
        "RAND",
        "REPLACE",
        "REVERSE",
        "RIGHT",
        "ROW_NUMBER",
        "RTRIM",
        "SCOPE_IDENTITY",
        "SQRT",
        "STUFF",
        "SUBSTRING",
        "TRIM",
        "TYPEOF",
        "UPPER",
        "GROUP_CONCAT",
        "STRFTIME",
        "JULIANDAY",
        "RANDOM",
        "HEX",
        "LENGTH",
    ];

    Prism.languages.pbsql = {
        comment: sql.comment,
        // SQLCMD commands, e.g. ":setvar", ":r file.sql", "!! ls"
        sqlcmd: {
            pattern: /(^|\n)[ \t]*[:!][^\n]*/,
            lookbehind: true,
            alias: "sqlcmd",
        },
        string: sql.string,
        identifier: sql.identifier,
        // system schemas and their objects (sys.xxx, INFORMATION_SCHEMA.xxx)
        "system-object": {
            pattern: /\b(?:sys|information_schema)\b(?:\s*\.\s*\w+)?/i,
        },
        // stored procedures
        "stored-procedure": {
            pattern: /\b(?:sp_|xp_|dt_)\w+/i,
        },
        // parameters and variables
        variable: /@@?[\w.$]+/,
        function: {
            pattern: new RegExp("\\b(?:" + functions.join("|") + ")(?=\\s*\\()", "i"),
        },
        keyword: sql.keyword,
        boolean: sql.boolean,
        number: sql.number,
        operator: sql.operator,
        punctuation: sql.punctuation,
    };
})();
