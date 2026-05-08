# Markdown And Mobile File Tags Design

## Goal

Improve chat readability by making rendered markdown more polished, and make the mobile `@` file suggestion popup easier to tap and read.

## Design

Markdown rendering keeps the existing ReactMarkdown, GFM, math, Mermaid, and CodeBlock behavior. The implementation adds a small `table` wrapper component so wide tables scroll inside the bubble, then upgrades `markdown.css` for better spacing, headings, lists, quotes, tables, inline code, code blocks, and mobile overflow.

The `@` file autocomplete keeps the current trigger detection and keyboard behavior. Rows gain explicit filename/path text spans, and CSS turns the mobile popup into a compact fixed bottom sheet with safe-area padding, large tap targets, and long-path truncation.

## Testing

Renderer tests cover the new table wrapper. Autocomplete tests cover the new two-line row structure and long-path display. CSS contract tests cover the mobile at-tag bottom-sheet rules and markdown table wrapper.
