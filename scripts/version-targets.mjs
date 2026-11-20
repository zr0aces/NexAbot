// VERSION is the only application release slot. Workspace packages are private
// and unversioned; the OpenAPI version describes the independent API contract.
export default {
  targets: [],
  build: [{ command: 'corepack', args: ['pnpm', 'build'] }],
};
