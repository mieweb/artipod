# Seccomp Security Profile

This directory contains the seccomp (Secure Computing Mode) profile used by ArtiPod containers to restrict dangerous system calls.

## Overview

The `sandbox.json` profile implements a **whitelist-based** security policy:
- **Default action**: `SCMP_ACT_ERRNO` (deny all syscalls by default)
- **Allowed syscalls**: Explicitly whitelisted safe operations
- **Blocked syscalls**: Everything not in the whitelist

## What is Blocked?

The following dangerous syscalls are **blocked** by not being in the whitelist:

### Kernel Module Operations
- `init_module`, `finit_module`, `delete_module` - Cannot load/unload kernel modules

### System Control
- `reboot`, `kexec_load`, `kexec_file_load` - Cannot reboot system or load kernel images

### Filesystem Mounting
- `mount`, `umount`, `umount2`, `pivot_root` - Cannot mount/unmount filesystems

### Namespace Manipulation
- `unshare`, `setns` (with dangerous flags) - Limited namespace operations

### Swap Control
- `swapon`, `swapoff` - Cannot control swap

### Process Tracing/Debugging
- `ptrace` - Cannot debug or trace other processes

### Kernel Logging
- `syslog` - Cannot access kernel logs

### Direct Hardware Access
- `iopl`, `ioperm` - Cannot access hardware ports directly

### BPF Programs
- `bpf` - Cannot load eBPF programs

### Quota Management
- `quotactl` - Cannot manipulate disk quotas

### Key Management
- `keyctl`, `add_key`, `request_key` - Cannot access kernel keyring

### Performance Monitoring
- `perf_event_open` - Cannot use perf events (may leak information)

### Process Accounting
- `acct` - Cannot control process accounting

## What is Allowed?

The profile allows all normal operations needed for running bash commands and processing files:

- File I/O: read, write, open, close, stat, etc.
- Process management: fork, execve, wait, kill, etc.
- Memory operations: mmap, mprotect, brk, etc.
- Networking: socket, connect, bind, etc. (though network is disabled at Docker level)
- Signals: sigaction, sigreturn, etc.
- Time operations: clock_gettime, nanosleep, etc.
- File permissions: chmod, chown, etc.
- Directory operations: mkdir, rmdir, chdir, etc.

## Architecture Support

The profile supports multiple architectures:
- x86_64 (Intel/AMD 64-bit)
- x86 (Intel/AMD 32-bit)
- aarch64 (ARM 64-bit)
- arm (ARM 32-bit)

## Testing

To verify the profile works:

```bash
npm test  # Runs full test suite with seccomp enabled
```

## How It Works

The profile is loaded at container creation time and passed inline to Docker:

```typescript
SecurityOpt: [
  'no-new-privileges',
  `seccomp=${JSON.stringify(seccompProfile)}`
]
```

Any attempt to call a blocked syscall will result in an "Operation not permitted" error.

## Security Layers

Seccomp is one layer in ArtiPod's defense-in-depth approach:

1. **Unprivileged user** (`artipod` UID 1000)
2. **Dropped capabilities** (CapDrop: ALL)
3. **Seccomp profile** (this file) - blocks dangerous syscalls
4. **Network isolation** (NetworkMode: none by default)
5. **Resource limits** (512MB RAM, 1 CPU, 100 PIDs)
6. **Read-only root filesystem**
7. **No privilege escalation** (no-new-privileges)
8. **Private IPC namespace**

## References

- [Docker Seccomp Documentation](https://docs.docker.com/engine/security/seccomp/)
- [Linux Seccomp Manual](https://man7.org/linux/man-pages/man2/seccomp.2.html)
- [Seccomp BPF](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html)
