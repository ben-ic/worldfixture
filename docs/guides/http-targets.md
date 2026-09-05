# HTTP targets, RSS, and failures

The HTTP-target service reads the active world's
`projections/http-targets.json`. It supports only `GET` and `HEAD`. It does not
make outbound network requests.

The projection can define multiple pages and route paths in one local site. It
does not create multiple host names or listeners. Therefore, “multiple sites”
is not a supported claim.

| Target | Behavior |
| --- | --- |
| Site root and pages | HTML from the active world |
| Changing page | Returns the next configured variant until the final variant |
| RSS path | RSS 2.0 XML with stable GUIDs |
| Feed preview | Human-readable HTML for the first feed |
| Stable probe | Repeats its configured successful status |
| Failing probe | Repeats its configured failure status |
| Flapping probe | Cycles through its configured status sequence |
| `/metrics` | Prometheus text format |
| OpenAPI path | The projected OpenAPI document with the current server URL |
| Projected API paths | Fixed JSON response objects |

Feed items can have `available_after_seconds`. They become visible relative to
the service start time. Reset starts that schedule again.

Use `SITE_BASE_URL` from `worldfixture env`. The root page links to every target
that the active projection defines.
