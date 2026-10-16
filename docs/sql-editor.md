# PocketBase SQL Editor

The SQL Editor is a **superuser-only** workspace for running SQL against your PocketBase
database. It combines raw SQLite execution with native PocketBase collection and field
management, so you can create tables, add fields and run queries without leaving the
Dashboard.

An HTML version of this documentation is available from the SQL Editor info dropdown
(and at `/docs/sql-editor.html` when the dashboard is served).

> **New to SQL?** You do not need to be a database expert to use the editor. This page
> explains everything step by step. Every example can be copy-pasted and tried safely.

## Opening the SQL Editor

1. Log in to the Dashboard as a **superuser** (an `admin`-style account).
2. Open **Collections** in the left sidebar.
3. Click the **SQL Editor** button (the terminal icon) at the bottom of the sidebar.

You can also go directly to `/_/#/collections/sql-editor`.

> The SQL Editor is only visible to superusers. Regular app users can never open it.

## Quick start

Type a query in the editor and press **Ctrl+Enter** (or **Cmd+Enter** on macOS):

```sql
SELECT * FROM posts;
```

The results appear in a table **below** the editor. If the table has image/file columns
they are shown as thumbnails (see [Results](#results)).

A few things to know straight away:

- Every statement ends with a semicolon `;`.
- Query strings in this editor are **case-insensitive** — `select` and `SELECT` are the same.
- Queries that change data ask for confirmation before running.
- Only superusers can run anything here, so use it carefully.

## How statements are handled

Most statements run as raw SQL. A few are translated into **native PocketBase operations**
so that your schema stays consistent (visible in the Collections sidebar, the REST API,
filters, relations, and so on).

| Statement | What happens |
| --- | --- |
| `SELECT ...` | Raw query. Results are shown in a table below the editor (max 1000 rows). |
| `INSERT` / `UPDATE` / `DELETE` | Raw execution. The number of affected rows is reported. |
| `CREATE TABLE ...` | Creates a **native PocketBase collection** with native fields. |
| `DROP TABLE ...` | Deletes the matching native collection (falls back to raw SQL otherwise). |
| `ALTER TABLE ... ADD COLUMN` | Adds a native field to an existing collection. |
| `ALTER TABLE ... DROP COLUMN` | Removes a native field from an existing collection. |
| Everything else | Executed as raw SQL (`PRAGMA`, `ANALYZE`, `VACUUM`, ...). |

> **Why does this matter?** If you created tables with plain SQLite, the Dashboard would
> not know about them. By turning `CREATE TABLE` / `ALTER TABLE` into native PocketBase
> operations, the created collections show up everywhere in the app, just as if you had
> created them through the Dashboard UI.

## Writing and running queries

There are two ways to run a query:

### Run everything

- Click the **Run** button (the play icon) in the page header, **or**
- press **Ctrl+Enter** / **Cmd+Enter** inside the editor.

### Run only part of the editor

This is handy when you have several statements and only want to test one of them.

1. Highlight (select) the text you want to run.
2. Click **Run** — when text is selected the button label changes to **Run Selected** — **or**
   press **Ctrl+Enter**.

You can also click the small **arrow (▾)** next to the Run button to open a menu with two
choices:

- **Run** — runs the whole editor.
- **Run Selected** — runs only the highlighted text. This option is greyed out until you
  highlight something.

> Selecting text and running only that selection **does not change** what is stored in the
> editor — the full query stays in place after the selection finishes running.

## Editor keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Enter` / `Cmd+Enter` | Run the query (or the selection, if any) |
| `Ctrl+/` | Comment / uncomment the current line or selection (see below) |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |
| `Ctrl+L` | Select the current line |
| `Ctrl+D` | Select the word at the cursor |
| `Tab` | Indent the current line / selection |
| `Shift+Tab` | Un-indent the current line / selection |
| `Esc` | Leave the editor |

> The editor keeps its own undo history, so **Ctrl+Z / Ctrl+Y work reliably** even after
> commenting, indenting or using autocomplete.

### Comments

Comments are notes that the database ignores. Use them to explain your queries or to
temporarily disable a statement.

- **Single line:** press `Ctrl+/` with the cursor on one line (or a selection inside a
  single line). The line is prefixed with `//`:

  ```sql
  // SELECT * FROM posts;
  ```

- **Multiple lines:** highlight more than one line and press `Ctrl+/`. The whole block is
  wrapped in a `/* ... */` comment:

  ```sql
  /* CREATE TABLE images (
      posts TEXT,
      avatar FILE,
      images FILE,
      interests SELECT(football, Gaming, Coding)
  ); */
  ```

Press `Ctrl+/` again on the same text to remove the comment.

## Creating collections

Use `CREATE TABLE` to create a new collection:

```sql
CREATE TABLE posts (
    title TEXT,
    content TEXT,
    views INTEGER DEFAULT 0
);
```

Because `CREATE TABLE` produces a **native collection**, `posts` immediately appears in
the Collections sidebar and is available through the Records API.

> PocketBase automatically adds the system fields `id`, `created` and `updated` to every
> collection, so you do not need to define them yourself.

## PocketBase field types

Besides the standard SQL types, column definitions may use PocketBase-specific type
keywords so you can create any field type supported by the Dashboard:

| Keyword | Field type | Options / example |
| --- | --- | --- |
| `TEXT(500)` | Plain text | optional max length |
| `EDITOR` / `RICH` / `HTML` | Rich text editor | |
| `NUMBER`, `INTEGER`, `REAL` | Number | `INTEGER` is integer-only |
| `BOOL` / `BOOLEAN` | Bool | |
| `EMAIL` | Email | |
| `URL` | URL | |
| `DATE` / `DATETIME` | Date | |
| `AUTODATE` | Autodate | auto set on create |
| `FILE` | File | |
| `RELATION(collection)` | Relation | `RELATION(posts)`, optional max select as 2nd arg |
| `SELECT(a,b,c)` | Select | comma separated values |
| `JSON` | JSON | |
| `GEOPOINT` / `GEO` | Geo Point | |
| `PASSWORD` | Password | |

Constraints such as `NOT NULL` and `PRIMARY KEY` are recognised and mapped to the field
`required` option.

```sql
CREATE TABLE articles (
    title TEXT NOT NULL,
    cover FILE,
    author RELATION(users),
    status SELECT(draft, published),
    tags SELECT(news, tech, life),
    location GEOPOINT,
    meta JSON,
    published_at AUTODATE
);
```

## Altering collections

```sql
-- add a native field
ALTER TABLE articles ADD COLUMN summary TEXT;

-- add a PocketBase specific field
ALTER TABLE articles ADD COLUMN thumbnail FILE;

-- remove a field
ALTER TABLE articles DROP COLUMN summary;
```

System fields (`id`, `created`, `updated`) cannot be removed.

## Dropping collections

```sql
DROP TABLE articles;
```

> Dropping a collection also deletes **all of its records**. This cannot be undone.

## Results

`SELECT` results are rendered in a table below the editor:

- The `id` column is **always shown first**, no matter where it is in your query.
- Click a column header to **sort** the results by that column (click again to reverse).
- Only the first 250 rows are shown at first. If there are more, a **Load remaining**
  button appears at the bottom of the table. At most **1000 rows** are returned per query.
- A **Export as CSV** button appears below the table once there are rows. It downloads
  the current result as a `.csv` file that you can open in Excel, Google Sheets, etc.

### Images and files

Image values are rendered as thumbnails:

- **PocketBase file fields** — when the query selects from a collection (eg.
  `SELECT * FROM posts`), file columns are resolved to their real file URL and shown as
  clickable image cards (identical to the Collections table, including the preview modal).
  Your query must include the record `id` column for this to work (eg. `SELECT * FROM posts`
  rather than selecting only a few columns).
- **Image URLs / data URIs** — any other value that looks like an image (a full URL, a
  relative path ending in an image extension, or a `data:image/...` URI) is shown as a
  thumbnail, with a text fallback if the image fails to load.

## History

Your recently executed queries are stored **locally in your browser** (last 15) and can be
re-run from the **history menu** (the clock icon in the page header). Click an entry to
load it back into the editor, or use the small **Clear** link to remove an entry.

> History is kept in your browser only — it is never sent to the server and is not shared
> with other users.

## Syntax colors

The editor uses an SSMS-inspired color scheme to make queries easier to read:

- **Blue** — keywords (`SELECT`, `FROM`, `WHERE`, ...)
- **Dark green** — comments
- **Red** — strings / text literals
- **Green** — system schemas (`sys`, `INFORMATION_SCHEMA`)
- **Magenta** — functions (`COUNT`, `NOW`, ...)
- **Maroon** — stored procedures (`sp_*`, `xp_*`)
- **Teal** — line numbers and parameters
- **Dark gray** — operators
- **Black on silver** — SQLCMD commands

## Safety and confirmations

- Queries that may modify data or the schema — `INSERT`, `UPDATE`, `DELETE`, `CREATE`,
  `DROP`, `ALTER`, `REPLACE` — show a confirmation prompt before running.
- Queries time out after **3 minutes**.
- Read-only `SELECT` queries run without a confirmation prompt.

## Command cheat sheet

```sql
-- read data
SELECT * FROM posts;
SELECT id, title FROM posts WHERE views > 100 ORDER BY created DESC;

-- create a collection
CREATE TABLE notes (title TEXT, body EDITOR, done BOOL);

-- add / remove a field
ALTER TABLE notes ADD COLUMN priority SELECT(low, medium, high);
ALTER TABLE notes DROP COLUMN priority;

-- change data
INSERT INTO notes (title, body) VALUES ('Hello', 'World');
UPDATE notes SET done = true WHERE title = 'Hello';
DELETE FROM notes WHERE title = 'Hello';

-- list tables
SELECT name FROM sqlite_master WHERE type = 'table';
```

## Troubleshooting

**I cannot see the SQL Editor.**
You are not logged in as a superuser. Log in with a superuser account.

**My query runs but I do not see a table.**
Only `SELECT` statements return a result table. `INSERT` / `UPDATE` / `DELETE` report the
number of affected rows instead.

**Only 250 rows are shown.**
Click **Load remaining** at the bottom of the table. A maximum of 1000 rows is returned per
query.

**My image column shows raw text instead of a thumbnail.**
Make sure the query selects from a real collection and includes the `id` column (eg.
`SELECT * FROM posts`). File fields can only be resolved when the record id is known.

**Ctrl+Z does nothing.**
Click inside the editor first so it has focus, then use `Ctrl+Z` to undo and `Ctrl+Y` to
redo.

**What is the difference between `SELECT` and the other statements?**
`SELECT` reads data and shows a table. All the other statements change data or the schema,
and ask for confirmation first.
