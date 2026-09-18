// electron-builder beforeBuild hook.
// node-pty ships N-API prebuilds and cannot be compiled here (its winpty dependency needs git),
// so rebuild every other native module for Electron here; the builder's own rebuild is off (npmRebuild: false).
//
// Note: with npmRebuild set to false the packager returns before it resolves this hook, so nothing
// here runs today. Anything that must run on every build belongs in beforePack instead — that is
// where scripts/check-packaged-files.js lives.
module.exports = async function beforeBuild(context) {
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({
    buildPath: context.appDir,
    electronVersion: context.electronVersion,
    arch: context.arch,
    ignoreModules: ['node-pty'],
    force: true,
  });
};
