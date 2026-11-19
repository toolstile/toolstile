// scripts/build-binary.mjs resolves this import to the built Nitro server, which
// starts listening when loaded and exports nothing the local commands use.
declare module "toolstile:server" {}
