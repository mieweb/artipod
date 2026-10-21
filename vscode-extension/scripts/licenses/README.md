# Canonical license text fallbacks

These texts are used when an upstream npm package declares a license in its
package.json but omits a standalone license file. The generated notice identifies
that case and preserves the package's author metadata without inventing copyright
attribution. Bundled upstream license/COPYING/NOTICE files take precedence.

- `Apache-2.0.txt`: https://www.apache.org/licenses/LICENSE-2.0.txt
- `MIT.txt`: https://github.com/spdx/license-list-data/blob/main/text/MIT.txt
- `GPL-3.0-only.txt`: https://www.gnu.org/licenses/gpl-3.0.txt

GPL version 3 is included because LGPL version 3 incorporates its terms.
