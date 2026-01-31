/**
 * Mock: expo-task-manager
 */
const _tasks: Record<string, Function> = {};

export function defineTask(taskName: string, executor: Function): void {
  _tasks[taskName] = executor;
}

export async function isTaskRegisteredAsync(taskName: string): Promise<boolean> {
  return taskName in _tasks;
}

export function __getTask(taskName: string): Function | undefined {
  return _tasks[taskName];
}
