// Rocket Suite installer: a self-extracting stub.
//
// The build puts three things in one file: this executable, the portable zip,
// and, at the very end, the length of this executable as a 64-bit integer. That
// last field is how the stub finds where its payload starts, so the payload can
// be any size without being embedded as a resource.
//
// Run, it extracts the zip to a temporary folder and starts the setup.cmd inside
// it, which installs into the user's profile and adds the shortcuts.

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Windows.Forms;

internal static class Program
{
    private static int Main()
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        long total = new FileInfo(self).Length;
        long payloadStart = Footprint(self, total);

        if (payloadStart <= 0 || payloadStart >= total - 8)
        {
            MessageBox.Show("This file is not a complete Rocket Suite installer.", "Rocket Suite Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        string tempRoot = Path.Combine(
            Path.GetTempPath(), "RocketSuite-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(tempRoot);

        try
        {
            string zipPath = Path.Combine(tempRoot, "payload.zip");
            ExtractPayload(self, zipPath, payloadStart, total - 8);

            string tree = Path.Combine(tempRoot, "tree");
            ZipFile.ExtractToDirectory(zipPath, tree);
            File.Delete(zipPath);

            // The portable zip has a single RocketSuite folder inside it.
            string inner = Path.Combine(tree, "RocketSuite");
            if (Directory.Exists(inner)) tree = inner;

            string setup = Path.Combine(tree, "setup.cmd");
            if (!File.Exists(setup))
            {
                MessageBox.Show("The download is damaged: the installer payload is incomplete.", "Rocket Suite Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 3;
            }

            var start = new ProcessStartInfo("cmd.exe", "/c \"" + setup + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = tree
            };
            var setupOutput = new StringBuilder();
            using (Process setupProcess = Process.Start(start))
            {
                setupProcess.OutputDataReceived += (sender, args) =>
                {
                    if (args.Data != null) lock (setupOutput) setupOutput.AppendLine(args.Data);
                };
                setupProcess.ErrorDataReceived += (sender, args) =>
                {
                    if (args.Data != null) lock (setupOutput) setupOutput.AppendLine(args.Data);
                };
                setupProcess.BeginOutputReadLine();
                setupProcess.BeginErrorReadLine();
                setupProcess.WaitForExit();
                setupProcess.WaitForExit();
                if (setupProcess.ExitCode != 0)
                {
                    string details;
                    lock (setupOutput) details = setupOutput.ToString().Trim();
                    if (details.Length > 2500) details = details.Substring(details.Length - 2500);
                    MessageBox.Show("Rocket Suite setup did not complete.\r\n\r\nExit code: "
                            + setupProcess.ExitCode
                            + (details.Length == 0 ? "" : "\r\n\r\n" + details),
                            "Rocket Suite Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return setupProcess.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("Rocket Suite could not be installed.\r\n\r\n" + ex.Message, "Rocket Suite Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 4;
        }
        finally
        {
            try { Directory.Delete(tempRoot, true); } catch (IOException) { }
        }
    }

    /// <summary>The length of this executable, read from the last eight bytes of the file.</summary>
    private static long Footprint(string self, long total)
    {
        if (total < 16) return -1;
        var tail = new byte[8];
        using (var file = new FileStream(self, FileMode.Open, FileAccess.Read))
        {
            file.Seek(-8, SeekOrigin.End);
            int read = file.Read(tail, 0, 8);
            if (read != 8) return -1;
        }
        return BitConverter.ToInt64(tail, 0);
    }

    private static void ExtractPayload(string self, string zipPath, long start, long end)
    {
        const int Chunk = 1 << 20;
        using (var source = new FileStream(self, FileMode.Open, FileAccess.Read))
        using (var target = File.Create(zipPath))
        {
            source.Seek(start, SeekOrigin.Begin);
            var buffer = new byte[Chunk];
            long remaining = end - start;
            while (remaining > 0)
            {
                int want = (int)Math.Min(Chunk, remaining);
                int read = source.Read(buffer, 0, want);
                if (read <= 0) throw new EndOfStreamException("the installer is truncated");
                target.Write(buffer, 0, read);
                remaining -= read;
            }
        }
    }

}
