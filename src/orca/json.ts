// What an `orca ... --json` command answers keeps its payload under `result`.
export const result = <T>(json: string): T => ((JSON.parse(json) as { result?: T }).result ?? ({} as T))
