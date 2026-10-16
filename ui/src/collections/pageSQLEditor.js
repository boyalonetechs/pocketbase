import { collectionsSidebar } from "./collectionsSidebar";

const SQL_HISTORY_STORAGE_KEY = "pbSQLEditorHistory";

const SQL_KEYWORDS = [
    "SELECT",
    "FROM",
    "WHERE",
    "INSERT",
    "INTO",
    "VALUES",
    "UPDATE",
    "SET",
    "DELETE",
    "CREATE",
    "TABLE",
    "ALTER",
    "ADD",
    "COLUMN",
    "DROP",
    "TRUNCATE",
    "JOIN",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "FULL",
    "CROSS",
    "ON",
    "USING",
    "GROUP",
    "BY",
    "ORDER",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "DISTINCT",
    "AS",
    "AND",
    "OR",
    "NOT",
    "NULL",
    "IS",
    "IN",
    "LIKE",
    "GLOB",
    "BETWEEN",
    "EXISTS",
    "UNION",
    "ALL",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "TOTAL",
    "GROUP_CONCAT",
    "PRAGMA",
    "VACUUM",
    "ANALYZE",
    "IF",
    "PRIMARY",
    "KEY",
    "UNIQUE",
    "DEFAULT",
    "CHECK",
    "ASC",
    "DESC",
    "CAST",
    "EXPLAIN",
    "QUERY",
    "PLAN",
    // PocketBase field type keywords
    "EDITOR",
    "RICH",
    "HTML",
    "FILE",
    "FILES",
    "RELATION",
    "SELECT",
    "ENUM",
    "JSON",
    "GEOPOINT",
    "GEO",
    "AUTODATE",
    "EMAIL",
    "URL",
    "PASSWORD",
    "NUMBER",
    "REAL",
    "TEXT",
    "BOOL",
    "DATE",
    "DATETIME",
];

export function pageSQLEditor(route) {
    app.store.title = "SQL Editor";

    const uniqueId = "sql_editor_" + app.utils.randomString();
    const editorId = uniqueId + "editor";
    const requestKey = uniqueId + "executeSQL";
    const defaultMaxRows = 250;

    const pageData = store({
        isExecuting: false,
        maxRows: defaultMaxRows,
        query: "",
        result: {},
        sort: {},
        errorMsg: "",
        hasSelection: false,
        executedHistory: app.utils.getLocalHistory(SQL_HISTORY_STORAGE_KEY, []),

        get orderedColumns() {
            const columns = pageData.result?.columns || [];

            // the "id" column should always be first (keep the original index for row access/sorting)
            const mapped = columns.map((col, index) => ({ name: col.name, index }));

            const idPos = mapped.findIndex((col) => String(col.name).toLowerCase() == "id");
            if (idPos > 0) {
                mapped.unshift(mapped.splice(idPos, 1)[0]);
            }

            return mapped;
        },
        get sortedResultRows() {
            // no client-side sort
            if (typeof pageData.sort?.index == "undefined") {
                const rows = pageData.result?.rows || [];
                return pageData.maxRows >= rows.length ? rows : rows.slice(0, pageData.maxRows);
            }

            const isAsc = !!pageData.sort?.asc;

            const sorted = pageData.result?.rows?.toSorted((rowA, rowB) => {
                let valA = rowA[pageData.sort.index];
                let valB = rowB[pageData.sort.index];

                // swap
                if (!isAsc) {
                    valA = rowB[pageData.sort.index];
                    valB = rowA[pageData.sort.index];
                }

                if (valA == valB) {
                    return 0;
                }
                if (valA == null) {
                    return -1;
                }
                if (valB == null) {
                    return 1;
                }
                return String(valA).localeCompare(String(valB));
            }) || [];

            return pageData.maxRows >= sorted.length ? sorted : sorted.slice(0, pageData.maxRows);
        },
        get totalRemainingRows() {
            return (pageData.result?.rows?.length << 0) - pageData.sortedResultRows.length;
        },
        get idColumnIndex() {
            return (pageData.result?.columns || []).findIndex((c) => String(c.name).toLowerCase() == "id");
        },
        // resolves the source collection of the executed query so that PocketBase
        // file fields can be rendered as thumbs, just like in the collections table
        get fileContext() {
            const tableName = getQueryTableName(pageData.query);
            if (!tableName) {
                return null;
            }

            const collection = app.store.collections?.find((c) => c.name == tableName || c.id == tableName);
            if (!collection) {
                return null;
            }

            const fileFields = (collection.fields || [])
                .filter((f) => f.type == "file")
                .map((f) => f.name.toLowerCase());

            if (!fileFields.length) {
                return null;
            }

            return {
                collectionId: collection.id,
                collectionName: collection.name,
                fileFields,
            };
        },
    });

    function getQueryTableName(query) {
        if (!query) {
            return "";
        }

        const match = /(?:from|join|update|into)\s+["'`\[]?([a-z0-9_]+)["'`\]]?/i.exec(query);
        return match?.[1] || "";
    }

    // autocomplete suggestions: SQL keywords, collection names and the
    // field names of the collection currently referenced by the query
    function getSQLSuggestions(word) {
        word = (word || "").toLowerCase();
        if (!word) {
            return [];
        }

        const suggestions = new Set(SQL_KEYWORDS);

        const collections = app.store.collections || [];
        for (const c of collections) {
            suggestions.add(c.name);
        }

        // add the fields of the collection referenced in the query
        const tableName = getQueryTableName(pageData.query);
        if (tableName) {
            const collection = collections.find((c) => c.name == tableName || c.id == tableName);
            for (const f of collection?.fields || []) {
                suggestions.add(f.name);
            }
        }

        return Array.from(suggestions)
            .filter((s) => s.toLowerCase() != word && s.toLowerCase().startsWith(word))
            .slice(0, 12);
    }

    function parseFilenames(val) {
        if (typeof val != "string" || !val) {
            return [];
        }

        const trimmed = val.trim();

        // multiple files are stored as a JSON array
        if (trimmed.startsWith("[")) {
            try {
                const arr = JSON.parse(trimmed);
                if (Array.isArray(arr)) {
                    return arr.filter((v) => typeof v == "string" && v);
                }
            } catch {
                // fall through
            }
        }

        return [val];
    }

    const imageExtRegex = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)(\?.*)?$/i;

    function isImageValue(val) {
        if (typeof val != "string" || !val || val.length > 2048) {
            return false;
        }

        const trimmed = val.trim();

        return trimmed.startsWith("data:image/") || imageExtRegex.test(trimmed);
    }

    function isFileTypeValue(val) {
        if (typeof val != "string" || !val || val.length > 2048) {
            return false;
        }

        const trimmed = val.trim();

        // only treat as a file when the value looks like a filename/url and not
        // an arbitrary text (eg. no spaces and a known file extension)
        if (/\s/.test(trimmed)) {
            return false;
        }

        return app.utils.getFileType(trimmed) != "file"
            || /\.(pdf|\w{1,5})(\?.*)?$/i.test(trimmed);
    }

    // renders a file-type aware placeholder (icon) for a plain filename value
    function renderFileTypeThumb(filename) {
        const type = app.utils.getFileType(filename);
        return t.span(
            { className: "thumb sm", title: filename },
            t.i({ className: app.utils.fileTypeIcons[type] || "ri-file-line", ariaHidden: true }),
        );
    }

    function renderCellValue(col, rowData) {
        const val = rowData[col.index];

        // PocketBase file fields -> render as thumbs (same as the collections table)
        const fileContext = pageData.fileContext;
        const isFileField = fileContext
            && fileContext.fileFields.includes(String(col.name).toLowerCase());

        if (isFileField && val != null && val !== "") {
            const filenames = parseFilenames(val);

            if (filenames.length) {
                // with a record id we can resolve the real file URLs (full thumbs)
                if (pageData.idColumnIndex >= 0) {
                    const rowId = rowData[pageData.idColumnIndex];
                    if (rowId) {
                        return t.div(
                            { className: "sql-editor-thumbs" },
                            filenames.map((filename) => {
                                return app.components.recordFileThumb({
                                    record: () => ({
                                        id: rowId,
                                        collectionId: fileContext.collectionId,
                                        collectionName: fileContext.collectionName,
                                    }),
                                    filename: filename,
                                });
                            }),
                        );
                    }
                }

                // otherwise fall back to file-type placeholders
                return t.div(
                    { className: "sql-editor-thumbs" },
                    filenames.map((filename) => renderFileTypeThumb(filename)),
                );
            }
        }

        if (val == null) {
            return "NULL";
        }

        // generic image values (urls, relative paths and data uris)
        if (isImageValue(val)) {
            return t.a(
                {
                    href: val,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    className: "sql-editor-image-cell",
                },
                t.img({
                    src: val,
                    loading: "lazy",
                    alt: "",
                    className: "sql-editor-thumb",
                    onerror: (e) => e.target.closest(".sql-editor-image-cell")?.classList.add("img-error"),
                }),
                t.span({ className: "sql-editor-image-fallback" }, app.utils.truncate(val, 2000)),
            );
        }

        // generic file/video/audio/document values -> file-type placeholder
        if (isFileTypeValue(val)) {
            return t.div(
                { className: "sql-editor-thumbs" },
                t.span(
                    { className: "thumb sm", title: val },
                    t.i({
                        className: app.utils.fileTypeIcons[app.utils.getFileType(val)] || "ri-file-line",
                        ariaHidden: true,
                    }),
                ),
                t.span({ className: "sql-editor-file-name" }, app.utils.truncate(val, 100)),
            );
        }

        return app.utils.truncate(val, 2000);
    }

    function needConfirmation(query) {
        if (!query?.trim()) {
            return false;
        }

        query = query?.replace(/[\s\;]/gm, " ").toUpperCase() + " ";

        return !![
            "DROP ",
            "ALTER ",
            "DELETE ",
            "UPDATE ",
            "INSERT ",
            "CREATE ",
            "REPLACE ",
        ].find((p) => query.includes(p));
    }

    function getSelectedQueryText() {
        const el = document.getElementById(editorId);
        const sel = window.getSelection();
        if (!el || !sel || sel.isCollapsed || !sel.rangeCount) {
            return "";
        }
        const range = sel.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) {
            return "";
        }
        return range.toString().trim();
    }

    function hasSelection() {
        return pageData.hasSelection && !!getSelectedQueryText();
    }

    async function runSelection() {
        const selected = getSelectedQueryText();
        if (!selected) {
            return executeSQLWithConfirm();
        }
        const prev = pageData.query;
        pageData.query = selected;
        try {
            return await executeSQLWithConfirm();
        } finally {
            pageData.query = prev;
        }
    }

    // allows triggering the confirm modal "yes" button with the Enter key.
    // When a modal button already has focus, its default Enter behaviour is
    // left untouched to avoid double actions (eg. pressing Enter on Cancel).
    function bindConfirmEnter(modalEl) {
        if (!modalEl) {
            return;
        }

        const onEnter = (e) => {
            if (e.key != "Enter" || e.isComposing) {
                return;
            }

            const focused = document.activeElement;
            if (focused && focused.tagName == "BUTTON" && modalEl.contains(focused)) {
                return;
            }

            e.preventDefault();
            modalEl.querySelector(".modal-footer .btn.warning")?.click();
        };

        const cleanup = () => {
            document.removeEventListener("keydown", onEnter);
            observer.disconnect();
        };

        const observer = new MutationObserver(() => {
            if (!modalEl.hasAttribute("data-modal-state")) {
                cleanup();
            }
        });
        observer.observe(modalEl, {
            attributes: true,
            attributeFilter: ["data-modal-state"],
        });

        document.addEventListener("keydown", onEnter);
    }

    async function executeSQLWithConfirm() {
        if (!needConfirmation(pageData.query)) {
            return executeSQL();
        }

        const modalEl = app.modals.confirm(
            t.div(
                { className: "txt-center" },
                t.h6(
                    null,
                    "Be careful - this will execute the query on the current database. The operation may modify or delete data and may not be reversible.",
                ),
            ),
            () => executeSQL(),
            null,
            { yesButton: "Run Query", noButton: "Cancel" },
        );

        bindConfirmEnter(modalEl);

        return modalEl;
    }

    async function executeSQL() {
        pageData.isExecuting = true;
        pageData.maxRows = defaultMaxRows;
        pageData.result = {};
        pageData.sort = {};
        pageData.errorMsg = "";

        const query = pageData.query.trim();
        if (!query) {
            app.pb.cancelRequest(requestKey);
            pageData.isExecuting = false;
            return;
        }

        try {
            const response = await app.pb.send("/api/sql-editor", {
                method: "POST",
                body: { query },
                requestKey: requestKey,
            });

            pageData.result = response;
            addToHistory(query);

            pageData.isExecuting = false;

            if (response.success) {
                app.toasts.success(response.message);
                // refresh the sidebar (a collection may have been created/removed/altered)
                app.store.loadCollections();
            }
        } catch (err) {
            if (!err?.isAbort) {
                pageData.isExecuting = false;
                pageData.errorMsg = err?.response?.message || err?.message || "Failed to execute query.";
                app.toasts.error(pageData.errorMsg);
            }
        }
    }

    function removeFromHistory(query) {
        function looseNormalize(str) {
            return str.replace(/[\s\;]/gm, "").toUpperCase();
        }

        const normalized = looseNormalize(query);

        for (let i = pageData.executedHistory.length - 1; i >= 0; i--) {
            if (
                pageData.executedHistory[i] == query
                || looseNormalize(pageData.executedHistory[i]) == normalized
            ) {
                pageData.executedHistory.splice(i, 1);
            }
        }
    }

    function addToHistory(query) {
        removeFromHistory(query);

        pageData.executedHistory.unshift(pageData.query);
        if (pageData.executedHistory.length > 15) {
            pageData.executedHistory.splice(15);
        }
    }

    function downloadCSV() {
        if (!pageData.sortedResultRows.length) {
            return;
        }

        const data = [pageData.orderedColumns.map((c) => c.name)].concat(
            pageData.sortedResultRows.map((row) => pageData.orderedColumns.map((c) => row[c.index])),
        );

        const name = "sql_editor_" + new Date().toISOString().replace(/[\-\:\.]/g, "") + ".csv";

        app.utils.downloadCSV(data, name);
    }

    function toggleSort(index) {
        if (pageData.sort?.index == index) {
            pageData.sort = {
                index: index,
                asc: !pageData.sort.asc,
            };
        } else {
            pageData.sort = {
                index: index,
                asc: true,
            };
        }
    }

    const watchers = [
        watch(() => JSON.stringify(pageData.executedHistory), (newVal, oldVal) => {
            if (typeof oldVal == "undefined") {
                return;
            }

            window.localStorage.setItem(SQL_HISTORY_STORAGE_KEY, newVal);
        }),
    ];

    const onSelectionChange = () => {
        pageData.hasSelection = !!getSelectedQueryText();
    };
    document.addEventListener("selectionchange", onSelectionChange);

    return t.div(
        {
            pbEvent: "pageSQLEditor",
            className: () => `page sql-editor-page`,
            onunmount: () => {
                document.removeEventListener("selectionchange", onSelectionChange);
                app.pb.cancelRequest(requestKey);
                watchers.forEach((w) => w?.unwatch());
            },
        },
        () => collectionsSidebar({ navigate: true }),
        t.div(
            { className: "page-content full-height" },
            t.header(
                { className: "page-header flex-nowrap" },
                t.nav(
                    { className: "breadcrumbs" },
                    t.a({ href: "#/collections", className: "breadcrumb-item" }, "Collections"),
                    t.div({ className: "breadcrumb-item" }, () => app.store.title),
                ),
                t.div(
                    { className: "page-header-secondary-btns" },
                    t.button(
                        {
                            type: "button",
                            className: "btn circle transparent secondary",
                            ariaDescription: app.attrs.tooltip("Recently executed queries", "right"),
                            "html-popovertarget": "sql-editor-history-dropdown",
                        },
                        t.i({ className: "ri-history-line", ariaHidden: true }),
                    ),
                    t.div(
                        {
                            id: "sql-editor-history-dropdown",
                            className: () =>
                                `dropdown left sql-console-history-dropdown ${
                                    !pageData.executedHistory.length ? "no-items" : ""
                                }`,
                            popover: "auto",
                        },
                        () => {
                            if (!pageData.executedHistory.length) {
                                return t.span({ className: "txt txt-hint p-5" }, "No recently executed queries.");
                            }

                            return pageData.executedHistory.map((item) => {
                                return t.button(
                                    {
                                        role: "button",
                                        className: "dropdown-item",
                                        onclick: (e) => {
                                            e.target.closest(".dropdown").hidePopover();
                                            pageData.query = item;

                                            document.getElementById(editorId)?.click();
                                        },
                                    },
                                    t.span(
                                        { className: "query" },
                                        () => app.utils.truncate(item, 800),
                                    ),
                                    t.small(
                                        {
                                            role: "button",
                                            className: "remove-btn link-hint m-l-auto p-l-5 p-r-5",
                                            title: "Clear",
                                            onauxclick: (e) => {
                                                e.stopPropagation();
                                                return false;
                                            },
                                            onclick: (e) => {
                                                e.stopPropagation();
                                                removeFromHistory(item);
                                                return false;
                                            },
                                        },
                                        t.i({ className: "ri-close-line", ariaHidden: true }),
                                    ),
                                );
                            });
                        },
                    ),
                ),
                t.div(
                    { className: "page-header-primary-btns" },
                    t.div(
                        { className: "btns" },
                        t.button(
                            {
                                type: "button",
                                className: () => `btn sm ${pageData.isExecuting ? "loading" : ""}`,
                                disabled: () => pageData.isExecuting,
                                ariaDescription: () =>
                                    app.attrs.tooltip(
                                        hasSelection() ? "Run selected query (Ctrl+Enter)" : "Run query (Ctrl+Enter)",
                                        "left",
                                    ),
                                onclick: () => (hasSelection() ? runSelection() : executeSQLWithConfirm()),
                            },
                            t.i({ className: "ri-play-large-line", ariaHidden: true }),
                            t.span(
                                { className: "txt" },
                                () => (hasSelection() ? "Run Selected" : "Run"),
                            ),
                        ),
                        t.button(
                            {
                                type: "button",
                                className: () => `btn sm ${pageData.isExecuting ? "loading" : ""}`,
                                disabled: () => pageData.isExecuting,
                                "aria-label": "Run options",
                                "html-popovertarget": "sql-editor-run-dropdown",
                            },
                            t.i({ className: "ri-arrow-down-s-line", ariaHidden: true }),
                        ),
                        t.div(
                            {
                                id: "sql-editor-run-dropdown",
                                className: "dropdown sql-console-run-dropdown",
                                popover: "auto",
                            },
                            t.button(
                                {
                                    role: "button",
                                    className: "dropdown-item",
                                    onclick: (e) => {
                                        e.target.closest(".dropdown").hidePopover();
                                        executeSQLWithConfirm();
                                    },
                                },
                                t.i({ className: "ri-play-large-line", ariaHidden: true }),
                                t.span({ className: "txt" }, "Run"),
                            ),
                            t.button(
                                {
                                    role: "button",
                                    className: () => `dropdown-item ${hasSelection() ? "" : "disabled"}`,
                                    disabled: () => !hasSelection(),
                                    onclick: (e) => {
                                        if (!hasSelection()) {
                                            return;
                                        }
                                        e.target.closest(".dropdown").hidePopover();
                                        runSelection();
                                    },
                                },
                                t.i({ className: "ri-play-circle-line", ariaHidden: true }),
                                t.span({ className: "txt" }, "Run Selected"),
                            ),
                        ),
                    ),
                ),
            ),
            t.div(
                { className: "field sql-console-field" },
                app.components.codeEditor({
                    id: editorId,
                    language: "pbsql",
                    required: true,
                    name: "query",
                    lineNumbers: false,
                    autocomplete: getSQLSuggestions,
                    placeholder:
                        "e.g. SELECT * FROM posts;\nCREATE TABLE articles (title TEXT, cover FILE, author RELATION(users));\nALTER TABLE articles ADD COLUMN status SELECT(draft, published);",
                    value: () => pageData.query,
                    oninput: (val) => pageData.query = val,
                    onblur: (val) => pageData.query = val.trim(),
                    onkeydown: (e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                            e.preventDefault();
                            if (hasSelection()) {
                                runSelection();
                            } else {
                                executeSQLWithConfirm();
                            }
                        }
                    },
                }),
            ),
            t.div(
                { className: "flex field-help m-b-sm" },
                t.button(
                    {
                        type: "button",
                        className: "link-hint m-l-auto",
                        "html-popovertarget": uniqueId + "caveats_dropdown",
                    },
                    () => "SQL Editor info & custom commands",
                ),
                t.div(
                    {
                        id: uniqueId + "caveats_dropdown",
                        className: "dropdown sm query-caveats-dropdown sql-editor-info-dropdown",
                        popover: "auto",
                    },
                    t.div(
                        { className: "sql-editor-info" },
                        t.strong(null, "Standard SQL"),
                        t.ul(
                            null,
                            t.li(null, "SELECT / INSERT / UPDATE / DELETE are executed as raw SQL."),
                            t.li(null, "SELECT results are shown in the table below (max 1000 rows)."),
                        ),
                        t.strong(null, "Native collection commands"),
                        t.ul(
                            null,
                            t.li(null, t.code(null, "CREATE TABLE name (...)"), " creates a native collection."),
                            t.li(null, t.code(null, "DROP TABLE name"), " removes the native collection."),
                            t.li(null, t.code(null, "ALTER TABLE name ADD COLUMN def"), " adds a field."),
                            t.li(null, t.code(null, "ALTER TABLE name DROP COLUMN field"), " removes a field."),
                        ),
                        t.strong(null, "PocketBase field types"),
                        t.ul(
                            null,
                            t.li(null, t.code(null, "EDITOR"), " / ", t.code(null, "RICH"), " - rich text"),
                            t.li(null, t.code(null, "FILE"), " - file(s)"),
                            t.li(null, t.code(null, "RELATION(collection)"), " - relation"),
                            t.li(null, t.code(null, "SELECT(a,b,c)"), " - select"),
                            t.li(null, t.code(null, "JSON"), " - json"),
                            t.li(null, t.code(null, "GEOPOINT"), " - geo point"),
                            t.li(null, t.code(null, "AUTODATE"), " - autodate"),
                            t.li(
                                null,
                                t.code(null, "EMAIL"),
                                " / ",
                                t.code(null, "URL"),
                                " / ",
                                t.code(null, "PASSWORD"),
                            ),
                            t.li(
                                null,
                                t.code(null, "BOOL"),
                                " / ",
                                t.code(null, "NUMBER"),
                                " / ",
                                t.code(null, "DATE"),
                            ),
                        ),
                        t.a(
                            {
                                className: "btn sm secondary block m-t-sm",
                                href: "/docs/sql-editor.html",
                                target: "_blank",
                                rel: "noopener noreferrer",
                            },
                            t.i({ className: "ri-book-2-line", ariaHidden: true }),
                            t.span({ className: "txt" }, "Full documentation"),
                        ),
                    ),
                ),
            ),
            // error alert
            t.div(
                {
                    hidden: () => pageData.isExecuting || !pageData.errorMsg,
                    className: "alert danger m-b-sm",
                },
                t.pre(null, () => pageData.errorMsg),
            ),
            // success alert
            t.div(
                {
                    hidden: () =>
                        pageData.isExecuting || pageData.errorMsg || !pageData.result?.success
                        || !!(pageData.result?.columns?.length),
                    className: "alert success m-b-sm",
                },
                t.p({ className: "txt-bold" }, () => pageData.result?.message || "Query executed successfully!"),
                () => {
                    if (pageData.result?.affectedRows) {
                        return t.p(null, "Affected rows: ", pageData.result.affectedRows);
                    }
                },
            ),
            // rows
            t.div(
                {
                    hidden: () => pageData.isExecuting || !pageData.result?.columns?.length,
                    className: "sql-editor-result",
                },
                t.div(
                    { className: "sql-editor-result-heading" },
                    t.span(null, "Result"),
                    t.small(
                        { className: "txt-hint" },
                        "Rows: ",
                        () => pageData.result?.rows?.length || 0,
                    ),
                ),
                t.div(
                    { className: "page-table-wrapper" },
                    t.table(
                        { className: "sql-console-table responsive-table optimize" },
                        t.thead(
                            { className: "sticky" },
                            t.tr(null, () => {
                                return pageData.orderedColumns.map((col) => {
                                    return t.th({
                                        textContent: col.name,
                                        className: () => {
                                            let classes = "sort-handle";

                                            if (pageData.sort?.index == col.index) {
                                                classes += pageData.sort.asc ? " asc" : " desc";
                                            }

                                            return classes;
                                        },
                                        onclick: () => toggleSort(col.index),
                                    });
                                });
                            }),
                        ),
                        t.tbody(
                            null,
                            () => {
                                if (!pageData.sortedResultRows.length) {
                                    return t.tr(
                                        null,
                                        t.td(
                                            { colSpan: pageData.orderedColumns.length || 1, className: "txt-center" },
                                            t.span({ className: "txt-hint" }, "No rows found."),
                                        ),
                                    );
                                }

                                return pageData.sortedResultRows.map((rowData) => {
                                    return t.tr(
                                        null,
                                        () => {
                                            return pageData.orderedColumns.map((col) => {
                                                return t.td(
                                                    { "html-data-name": col.name },
                                                    renderCellValue(col, rowData),
                                                );
                                            });
                                        },
                                    );
                                });
                            },
                            t.tr(
                                {
                                    hidden: () => (
                                        pageData.isExecuting
                                        || !pageData.result?.rows?.length
                                        || pageData.result.rows.length <= pageData.sortedResultRows.length
                                    ),
                                },
                                t.td(
                                    { colSpan: 99 },
                                    t.button(
                                        {
                                            type: "button",
                                            className: "btn lg secondary load-more-btn",
                                            onclick: () => {
                                                pageData.maxRows = pageData.result?.rows?.length || defaultMaxRows;
                                            },
                                        },
                                        t.span({
                                            className: "txt",
                                            textContent: () => `Load remaining (${pageData.totalRemainingRows})`,
                                        }),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
                () => {
                    if (pageData.result?.rows?.length) {
                        return t.div(
                            { className: "txt-right m-t-sm" },
                            t.button(
                                {
                                    type: "button",
                                    className: "btn sm secondary",
                                    onclick: downloadCSV,
                                },
                                t.i({ className: "ri-download-line", ariaHidden: true }),
                                t.span({ className: "txt" }, "Export as CSV"),
                            ),
                        );
                    }
                },
            ),
            t.footer(
                { className: "page-footer" },
                t.span(
                    {
                        className: () => `exec-time ${pageData.isExecuting ? "faded" : ""}`,
                    },
                    "Status: ",
                    () => pageData.result?.success ? "Success" : pageData.isExecuting ? "Executing..." : "Ready",
                ),
                () => {
                    if (!pageData.result?.success) {
                        return;
                    }
                    return t.span({ className: "exec-time" }, `${pageData.result?.execTime || 0}ms`);
                },
                app.components.credits(),
            ),
        ),
    );
}
