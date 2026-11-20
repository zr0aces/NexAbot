// Root VERSION is embedded directly into images and the web build; example-deploy uses :latest.
export default {
  targets: [],
  build: [{ command: 'corepack', args: ['pnpm', 'build'] }],
};
