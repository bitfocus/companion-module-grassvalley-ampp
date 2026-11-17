## Grass Valley AMPP

Control routing and monitor tally, apps, and nodes on [Grass Valley AMPP](https://www.grassvalley.com/ampp/).

### Configuration

1. Enter your Platform URL.
2. Create an API Key in AMPP > Platform Tools > Identity Management > Generate API Key and choose "AMPP Control". Copy the API Key value, the Client ID is not needed.

### Actions

- **Route source to destination**
- **Lock or unlock destination**
- **Rename source** / **Rename destination**

### Presets

**Node status** has a group for each AMPP node, with buttons for its status (name and running apps), CPU and memory, GPU, and free disk space. Each turns red while its node is offline.

### Variables

Each source and destination has variables named by its AMPP id, e.g. `dest_<id>_source` (the routed source's name) and `dest_<id>_source_id` (its id). Others include the lock state, fabric, AMPP package and app state, each source's video format, and each node's online state and performance metrics.
