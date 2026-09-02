# artipod

The artipod CLI. This is an alias package so `npx artipod` works — everything
lives in [`@artipod/core`](https://www.npmjs.com/package/@artipod/core); this
package just runs its CLI.

```sh
npx artipod run -it              # fresh pod → artipod-bash, kept under ~/.artipod/pods
npx artipod run -it alpine:3.22  # a registry image, cloned in writable
npm install -g artipod           # permanent `artipod` on PATH
```

A pod is a virtual filesystem your AI can reason in, your users can shell
into, and your infrastructure can version, encrypt, and synchronize.
Docs, source, and the library API: [github.com/mieweb/artipod](https://github.com/mieweb/artipod).
