# Artwork

## Connector logos

Each catalog entry references its publisher's logo as an SVG, PNG or WebP file named by its SHA-256, published next to the v1 catalog on www and bundled in `packages/api/catalog/logos/`, so the app never requests third-party logo services. A logo file is at most 64 KB once encoded. SVG must not contain scripts, event handlers, `foreignObject`, entity declarations or external references; the catalog source rejects such artwork when a file is loaded or fetched instead of rewriting it. The app serves each logo as a same-origin image file at a content-addressed URL (see [connector catalog](connector-catalog.md#logos)); the UI shows it only as an image with empty alt text, never as page markup, and falls back to a generic mark.

The initial logos are publisher brand assets or publisher-served site icons, not generated approximations. SVG bytes are unchanged; raster icons were converted to PNG and downscaled to at most 96 pixels, enough for the largest tile at twice its size. The white padded tile is presentation.

Names and marks belong to their respective owners. Their use identifies an integration and does not imply endorsement. Review the publisher's brand terms when adding or updating a logo, and check it in both themes.

## Agent artwork

`packages/ui/src/assets/agents/` holds the marks for the agent apps in Connect an agent and those the dashboard recognizes from an agent's name (`detectAgentClient` in `packages/ui/src/agent-clients.ts`); `index.ts` maps each app to its file. Each mark is a publisher brand asset or an icon the publisher serves for the product, not a third-party icon set:

| File | App | Publisher and source |
| --- | --- | --- |
| `claude.svg` | Claude, Claude Code, Claude Desktop | Anthropic PBC, [Claude's favicon](https://claude.ai/favicon.svg) |
| `codex.png` | Codex | OpenAI, the Codex app icon bundled in the official desktop application |
| `cursor.svg` | Cursor | Anysphere, Inc., `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg` from the [brand assets](https://cursor.com/brand) |
| `vscode.svg` | VS Code | Microsoft, `vscode.svg` from the [VS Code brand icons](https://code.visualstudio.com/assets/branding/visual-studio-code-icons.zip) |
| `gemini.png` | Gemini CLI | Google, the Gemini sparkle served from gstatic.com for gemini.google.com |
| `cline.svg` | Cline | Cline Bot Inc., [`cline-icon-dark.svg`](https://cline.bot/assets/branding/logos/cline-icon-dark.svg) |
| `windsurf.svg` | Windsurf | Cognition, [windsurf.com/favicon.svg](https://windsurf.com/favicon.svg) |
| `goose.svg` | Goose | The goose project, `ui/desktop/src/images/icon.svg` in the [goose repository](https://github.com/aaif-goose/goose) at commit 392ccbf |
| `chatgpt.png` | ChatGPT | OpenAI, the 180px favicon served by chatgpt.com |
| `copilot.png` | Copilot Studio | Microsoft, the Copilot logo served from res.cdn.office.net for copilot.microsoft.com |
| `mistral.svg` | Mistral | Mistral AI, [mistral.ai/favicon.svg](https://mistral.ai/favicon.svg) |
| `perplexity.png` | Perplexity | Perplexity AI, [perplexity.ai/favicon.png](https://www.perplexity.ai/favicon.png) |
| `notion.png` | Notion | Notion Labs, the iOS logo served at notion.com/front-static/logo-ios.png |
| `slack.png` | Slackbot | Slack Technologies, the colored hash icon served from a.slack-edge.com |
| `mcpjam.png` | MCPJam | MCPJam, [mcpjam.com/icon.png](https://www.mcpjam.com/icon.png) |
| `n8n.svg` | n8n | n8n GmbH, the accent symbol from the [n8n brand guidelines](https://guidelines.n8n.design) |
| `agentcore.svg` | AgentCore | Amazon Web Services, `Arch_Amazon-Bedrock-AgentCore_64.svg` from the [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) |

SVG bytes are unchanged. PNG files larger than 96 pixels were downscaled to 96 pixels, enough for the largest tile at twice its size; `codex.png` is unchanged. Single-colour black marks (Cursor, Cline) invert on the dark tile.

```text
09596bda3e7cd42288deec94d3b4647bcc951c3b8855236e8a88d31e1766636f  agentcore.svg
b044c36d17817c3595bc90f987a06eef695d884a4914f4804d942376100bbb7e  chatgpt.png
b150888bc7257af83e3b85d3c2be4294f88986026f8168f6c12fc1fde6697350  claude.svg
a34dcb49437c420e107c986e1e63b721d64843e82238ba0c43786447c92e0589  cline.svg
8e82b26c98a10e45798ce48124515720657f7735fb8d0853b3f087eaa8a6b74e  codex.png
a2c2932d969dda2997781d8ba21473e9b92c2488a0b433e6bc47c54fefc8c0bd  copilot.png
c483c02f78eb2619778fdd959e72a9adfac4844854472cd2653d4cbfd60e4d71  cursor.svg
1b67e966b7fe0bfd1b09ec37ddbda43417c5fedc1b01487f06b18ac058f7d3a7  gemini.png
b4a9ab0aa1da378732f41c0e00733e7a37c9b97bab368ea6fddc25821ddbefc2  goose.svg
0df9c58da7abc45b7fecf6a3265404e184f9b5d2fe4d975486e12cd6d5cea6e5  mcpjam.png
66ceaf186f2075da38e5a3c2e46fc0015936e0cb57692d1f8ae0ba565354874d  mistral.svg
30c9c3805971765a8d3b30e1ba488d957f18c86d623296c3482a36213bf44646  n8n.svg
e67257715983ad79430bb680e38bccb482bad7fb66425a6026138333f9f98081  notion.png
69bd917017e4cbd421695064ecfae3915ca0626aa04ae2b7ed585409b047b536  perplexity.png
c0bcd8674433056513a1835774b0e3a2b860842c48a12ccdc778eb8482559f19  slack.png
74ad401c6487a0dc5af1f6b2935556ab2d3553ae45effc7e1697b4d117d046b6  vscode.svg
0aea67d09906da60df8fd54402b900991fd3dbc5032ade91e726e7d46eb41be8  windsurf.svg
```

Unrecognized agents keep a letter tile. A mark identifies the app an agent appears to be; it does not imply endorsement.
