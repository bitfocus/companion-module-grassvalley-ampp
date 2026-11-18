## Grass Valley AMPP

Control routing and monitor tally, apps, and nodes on [Grass Valley AMPP](https://www.grassvalley.com/ampp/).

### Configuration

1. Enter your Platform URL.
2. Create an API Key in AMPP > Platform Tools > Identity Management > Generate API Key and choose "AMPP Control". Copy the API Key value, the Client ID is not needed.

### Actions

- **Route Source**
- **Lock Destination**
- **Rename Source** / **Rename Destination**
- **Select Destination** / **Select Source** (optionally **Wait For Take**)
- **Take** / **Clear Selected Source**
- **Start App** / **Stop App** / **Restart App**

### Feedbacks

- **Source Routed**
- **Destination Locked**
- **Destination Tally** / **Source Tally**
- **Endpoint Enabled** / **Endpoint Running**
- **Node Online**
- **Destination Selected** / **Source Selected** / **Selected Source** / **Routed To Selected Destination**
- **App State** / **Any App State** / **App Error**

### Variables

Each source and destination has variables named by its AMPP id, e.g. `dest_<id>_source` (the routed source's name) and `dest_<id>_source_id` (its id). Others include the lock state, fabric, AMPP package and app state, each source's video format, and each node's online state and performance metrics.

- Apps: `app_<id>_name`, `_state`, `_error`, `_node`
- App totals: `apps_total`, `apps_running`, `apps_error`, `apps_error_names`
- Selection: `selected_destination`, `selected_destination_source`, `selected_source`, with `_id` variants
