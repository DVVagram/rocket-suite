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

internal static class Program
{
    private static int Main()
    {
        Console.Title = "Rocket Suite Setup";
        string self = Process.GetCurrentProcess().MainModule.FileName;
        long total = new FileInfo(self).Length;
        long payloadStart = Footprint(self, total);

        if (payloadStart <= 0 || payloadStart >= total - 8)
        {
            Console.Error.WriteLine("This file is not a complete Rocket Suite installer.");
            return Pause(2);
        }

        string tempRoot = Path.Combine(
            Path.GetTempPath(), "RocketSuite-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(tempRoot);

        try
        {
            string zipPath = Path.Combine(tempRoot, "payload.zip");
            Console.WriteLine("Unpacking Rocket Suite ...");
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
                Console.Error.WriteLine("The payload has no setup.cmd; the download is damaged.");
                return Pause(3);
            }

            var start = new ProcessStartInfo("cmd.exe", "/c \"" + setup + "\"")
            {
                UseShellExecute = false,
                WorkingDirectory = tree
            };
            using (Process setupProcess = Process.Start(start))
            {
                setupProcess.WaitForExit();
                return setupProcess.ExitCode;
            }
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

    private static int Pause(int code)
    {
        Console.Error.WriteLine("Press Enter to close.");
        Console.ReadLine();
        return code;
    }
}
