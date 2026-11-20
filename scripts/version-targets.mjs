import { replaceRequired } from './version-control.mjs';

// Pin deployable images from root VERSION. Leave dependency images untouched.
export default {
  targets: ['api', 'worker', 'web'].map(service => ({
    path: 'docs/example-deploy/compose.yml',
    transform: (content, version) => replaceRequired(content,
      new RegExp(`(image: "ghcr\\.io/[^"\\n]+/rivosnap-${service}:)[^"\\n]+"`),
      (_, prefix) => prefix + version + '"'),
  })),
  build: [{ command: 'corepack', args: ['pnpm', 'build'] }],
};
