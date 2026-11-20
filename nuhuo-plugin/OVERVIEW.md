# Nuhuo

Imports your providers and Workers from Nuhuo, so every agent on this host is ready to use. Pick a
Worker in the composer, or press **Chat** on the Nuhuo screen; the plugin applies its provider,
model, mode, Role instructions, Skills, MCP servers, and environment to the agent. Agents can start
your Workers on your other hosts as subagents.

## Setup

Nuhuo installs this plugin when IT allocates the host to you. Its setup writes the host's
credential to `~/.nuhuo/paseo/host.json`, or to `host.json` in the directory named by the daemon's
`NUHUO_PASEO_HOME` environment variable. The plugin pulls from Nuhuo when it starts, every five
minutes, and when you press **Import** on the Nuhuo screen.

## Data access

The plugin calls Nuhuo's host API with this host's token and stores the catalog, secret files,
instructions, and Skills next to the credential. It installs your Nuhuo providers as `nuhuo-`
provider profiles, with their API keys in Paseo's `config.json`, and saves your other hosts so the
app reaches them through this one. It reports this host's server ID and the models, modes, and
thinking options of its providers to Nuhuo. Other secret values go into an agent's environment and
MCP configuration when the agent opens; they are never saved in the agent's configuration.

## Limits

The plugin sets each agent's configuration; it does not stop a host owner from changing it. You
control this host and can disable the plugin, edit its files, or change a running agent's model and
mode. Your providers' accounts, IT's network policy, and Nuhuo's inventory enforce the limits that
must hold.
