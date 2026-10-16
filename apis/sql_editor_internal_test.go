package apis

import "testing"

func TestRewriteSelectToIncludeId(t *testing.T) {
	t.Parallel()

	fileFields := map[string]struct{}{
		"attachment": {},
		"images":     {},
	}

	scenarios := []struct {
		name     string
		query    string
		expected string
	}{
		{"file column", "select attachment from posts;", "SELECT id, attachment FROM posts"},
		{"file column no semicolon", "SELECT attachment FROM posts", "SELECT id, attachment FROM posts"},
		{"prefixed file column", "SELECT posts.attachment FROM posts", "SELECT id, posts.attachment FROM posts"},
		{"aliased file column", "SELECT attachment AS a FROM posts", "SELECT id, attachment AS a FROM posts"},
		{"star select untouched", "SELECT * FROM posts", "SELECT * FROM posts"},
		{"already id", "SELECT id, attachment FROM posts", "SELECT id, attachment FROM posts"},
		{"non file column untouched", "SELECT title FROM posts", "SELECT title FROM posts"},
		{"aggregate untouched", "SELECT COUNT(*) FROM posts", "SELECT COUNT(*) FROM posts"},
		{"join untouched", "SELECT attachment FROM posts p JOIN users u ON u.id = p.id", "SELECT attachment FROM posts p JOIN users u ON u.id = p.id"},
		{"group untouched", "SELECT attachment FROM posts GROUP BY attachment", "SELECT attachment FROM posts GROUP BY attachment"},
		{"where preserved", "SELECT attachment FROM posts WHERE title = 'x'", "SELECT id, attachment FROM posts WHERE title = 'x'"},
		{"order preserved", "SELECT images FROM posts ORDER BY created DESC", "SELECT id, images FROM posts ORDER BY created DESC"},
		{"multiline", "SELECT attachment\nFROM posts\nWHERE title = 'x'", "SELECT id, attachment FROM posts\nWHERE title = 'x'"},
	}

	for _, s := range scenarios {
		t.Run(s.name, func(t *testing.T) {
			result := rewriteSelectToIncludeId(s.query, fileFields)
			if result != s.expected {
				t.Fatalf("expected %q, got %q", s.expected, result)
			}
		})
	}
}

func TestRewriteSelectToIncludeIdNoFileFields(t *testing.T) {
	t.Parallel()

	query := "select attachment from posts;"
	if result := rewriteSelectToIncludeId(query, nil); result != query {
		t.Fatalf("expected no rewrite with empty file fields, got %q", result)
	}
}

func TestNormalizeSelectColumn(t *testing.T) {
	t.Parallel()

	scenarios := []struct {
		in       string
		expected string
	}{
		{"attachment", "attachment"},
		{" posts.attachment ", "attachment"},
		{"attachment AS a", "attachment"},
		{"posts.attachment as a", "attachment"},
		{"`attachment`", "attachment"},
		{"[attachment]", "attachment"},
		{`"attachment"`, "attachment"},
	}

	for _, s := range scenarios {
		if result := normalizeSelectColumn(s.in); result != s.expected {
			t.Fatalf("expected %q for %q, got %q", s.expected, s.in, result)
		}
	}
}
