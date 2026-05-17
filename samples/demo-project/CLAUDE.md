# Project Intelligence

This project uses [larkx](https://github.com/utoolslib/larkx) for code indexing.

Before working on any task, always use larkx MCP tools first: get_project_index for a full overview, search_symbol to locate functions, get_file_summary before reading a file, get_impact before changing a file, get_call_chain to trace logic, get_dead_code to find unused code. Only fall back to reading source files directly if MCP returns no result.
