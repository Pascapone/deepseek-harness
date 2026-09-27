export const name = 'test-model-default';
export const inject = ['agentDefaultModel'];
export function apply(ctx, config) { ctx.agentDefaultModel.registerScoped(config); }
