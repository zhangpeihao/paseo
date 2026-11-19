# Nuhuo

Runs agents on this host as the Workers your organization assigns in Nuhuo. Pick a Worker in the
composer; the plugin applies its provider, model, mode, Role instructions, MCP servers, and
environment to the agent.

## Setup

Nuhuo installs this plugin when it provisions a host. It writes the host bundle to
`~/.nuhuo/paseo/host-bundle.json`, or to the path in the daemon's `NUHUO_PASEO_BUNDLE`
environment variable, and secret files to the `secrets/` directory next to it.

## Data access

The plugin reads the host bundle and secret files on this host. It sends nothing over the network.
Secret values go into an agent's environment and MCP configuration when the agent opens; they are
never saved in the agent's configuration.

## Limits

The plugin sets each agent's configuration; it does not stop a host owner from changing it.
Anyone who controls this host can disable the plugin, edit the bundle, or change a running agent's
model and mode. Your organization's model gateway, credentials, and network policy enforce the
limits that must hold.
