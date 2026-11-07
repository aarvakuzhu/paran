# The shipped config has licensing on (LICENSE_URL points at the live server). Tests and help pictures run with it
# off unless they ask for it, so nothing reaches the live server and no privacy notice covers the screen.
# Usage: from lic_off import licensing_off; await licensing_off(ctx)   (right after creating the browser context)
# A later ctx.route('**/js/config.js*', ...) wins over this one (Playwright uses the most recent matching route).
import re

def config_with(body, url=''):
    """config.js text with LICENSE_URL set to url ('' = off) and the bundled production keys removed."""
    body = re.sub(r'LICENSE_URL: `[^`]*`', f'LICENSE_URL: `{url}`', body)
    return re.sub(r'LICENSE_KEYS: \[.*?\],', 'LICENSE_KEYS: [],', body, flags=re.S)

async def licensing_off(ctx):
    async def cfg(route):
        r = await route.fetch()
        await route.fulfill(status=200, content_type='text/javascript', body=config_with(await r.text()))
    await ctx.route('**/js/config.js*', cfg)
    await ctx.route('https://license.goligundu.com/**', lambda route: route.abort())
