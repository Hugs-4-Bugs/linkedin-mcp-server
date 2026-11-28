# Authentication Architecture

Separate MCP host/client authentication from LinkedIn OAuth identity. The server must not confuse a user's identity at the MCP service with their LinkedIn identity. Use standard, documented OAuth flows, state/nonce protections as applicable, redirect URI allowlists, PKCE where applicable, CSRF protections, strict token audience/issuer validation, secure token storage, revocation/disconnect handling, and scoped authorization. Validate host/client requirements at implementation time.

Do not assume one OAuth flow is compatible with both ChatGPT and Claude. Build compatibility adapters/configuration only after their requirements are verified.
