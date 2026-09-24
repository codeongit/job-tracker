# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `codeongit/job-tracker`. Use the `gh` CLI for issue operations.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --comments` and fetch labels when needed.
- List: `gh issue list --state open --json number,title,body,labels,comments`, with appropriate filters.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Run `gh` inside this clone so it resolves the configured repository.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set to `yes` if this repo later treats external PRs as feature requests.

## Skill vocabulary

- “Publish to the issue tracker” means create a GitHub issue.
- “Fetch the relevant ticket” means read the GitHub issue and its comments.
