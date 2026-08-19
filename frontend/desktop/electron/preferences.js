export const closeBehaviors = ['ask', 'tray', 'quit'];

export function normalizeCloseBehavior(value) {
  return closeBehaviors.includes(value) ? value : 'ask';
}
