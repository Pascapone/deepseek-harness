export const name = 'test-preset-persona';
export const inject = ['systemPrompt'];
export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'test:persona', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: 'REVIEW_SPECIALIST_PERSONA' });
}
