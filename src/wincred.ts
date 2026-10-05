// Read-only access to Windows Credential Manager via Win32 CredReadW (through PowerShell).
//
// Do NOT use @napi-rs/keyring here: in v2.1.0, `Entry.withTarget(...).getPassword()` was
// observed to OVERWRITE the target credential with an empty (0-byte) secret, which destroyed
// the user's gh/git/Copilot tokens. CredReadW never writes. See docs/providers/copilot-usage.md.

import { execFile } from "node:child_process";

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class AgentsctlCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
"@
$target = [Console]::In.ReadToEnd().Trim()
$p = [IntPtr]::Zero
if (-not [AgentsctlCred]::CredReadW($target, 1, 0, [ref]$p)) { 'NOTFOUND'; exit 0 }
try {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][AgentsctlCred+CREDENTIAL])
  $bytes = New-Object byte[] $c.CredentialBlobSize
  if ($c.CredentialBlobSize -gt 0) { [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize) }
  'OK:' + [Convert]::ToBase64String($bytes)
} finally { [AgentsctlCred]::CredFree($p) }
`;

/** Decode a credential blob: UTF-16LE (cmdkey, Win32 tools) or UTF-8 (gh, go-keyring, Node tools). */
export function decodeCredentialBlob(buf: Buffer): string {
  if (buf.length >= 2 && buf.length % 2 === 0) {
    let zeros = 0;
    for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0) zeros++;
    if (zeros === buf.length / 2) return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

/**
 * Read a generic credential's secret by exact target name. Returns null if the target does not
 * exist, "" if it exists with an empty secret. Never writes.
 */
export function readGenericCredential(target: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`CredReadW failed: ${(stderr || err.message).trim().split(/\r?\n/)[0]}`));
        const out = stdout.trim();
        if (out === "NOTFOUND") return resolve(null);
        if (!out.startsWith("OK:")) return reject(new Error("CredReadW returned unexpected output"));
        resolve(decodeCredentialBlob(Buffer.from(out.slice(3), "base64")));
      },
    );
    child.stdin?.end(target);
  });
}
