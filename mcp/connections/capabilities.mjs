export const CONNECTION_CAPABILITIES = Object.freeze({
  GITHUB: Object.freeze([
    'repo.read',
    'repo.write',
    'pull_request.read',
    'pull_request.create',
  ]),
  SUPABASE: Object.freeze([
    'auth',
    'bridge.read',
    'bridge.write',
    'tasks.read',
    'tasks.write',
    'goals.read',
    'goals.write',
    'reviews.write',
  ]),
  VERCEL: Object.freeze([
    'project.read',
    'deployment.read',
    'deployment.create',
    'environment.read',
    'environment.write',
  ]),
});

export const hasConnectionCapability = (connection, capability) =>
  Boolean(connection?.capabilities?.includes(capability));
