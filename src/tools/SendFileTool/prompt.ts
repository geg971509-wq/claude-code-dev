export const DESCRIPTION =
  'Send files to another reachable Claude Code session.'

export const PROMPT = `Send one or more files to a peer session returned by ListAgents.

- Use this only for another session (uds, bridge, or cloud). Agents in this session already share the filesystem; send them an @path with SendMessage instead.
- Pass 1-16 file paths. Relative paths resolve from the current working directory.
- Each file must be a readable regular file no larger than 30 MB.
- An optional message is delivered alongside the files.`
