# Proxmox LXC scripts — moved

The community-scripts-style LXC pair lives in its own **public** repository:

**https://github.com/Kalinewb/graveklar-lxc**

```
ct/graveklar.sh                 # runs on the Proxmox host: creates the CT, holds update_script()
install/graveklar-install.sh    # runs inside the CT: installs the app
```

It has to be public and it has to be the only copy. `update` inside the
container re-fetches `ct/graveklar.sh` from
`raw.githubusercontent.com/Kalinewb/graveklar-lxc/main` over plain HTTPS with no
credentials — so a second copy edited here would silently not be the one that
runs. Clone that repo, change it there, push.

Create a container (on the Proxmox host shell):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kalinewb/graveklar-lxc/main/ct/graveklar.sh)"
```

This repository's URL is baked into `var_app_repo` in that script. Because it is
private, the script asks once for a GitHub token after the settings dialogue —
a fine-grained PAT with Contents: Read-only here is enough. The token is never
committed anywhere; inside the container it goes to `/root/.git-credentials`
(mode 600) so `update` keeps working. For an unattended run, pass it as
`var_app_token`.

See that repo's README for the container layout, the systemd timers, and the
post-install reverse-proxy checklist, and [DEPLOYMENT.md](../../DEPLOYMENT.md)
for the deployment background.
