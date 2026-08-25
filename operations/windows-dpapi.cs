using System;
using System.IO;
using System.Security.Cryptography;

// Fixed, non-interactive DPAPI helper for the Windows credential stores.
// Secret bytes enter and leave only through anonymous pipes. The operation and
// exact byte count are the only process arguments, and errors are intentionally
// silent so an exception can never copy input into a diagnostic stream.
public static class BrainWindowsDpapi
{
    private const int MaximumPayloadBytes = 3 * 1024 * 1024;

    public static int Main(string[] args)
    {
        byte[] inputBytes = null;
        byte[] outputBytes = null;

        try
        {
            int expectedLength;
            if (args.Length != 2 ||
                (args[0] != "protect" && args[0] != "unprotect") ||
                !Int32.TryParse(args[1], out expectedLength) ||
                expectedLength < 1 || expectedLength > MaximumPayloadBytes)
            {
                return 2;
            }

            Stream input = Console.OpenStandardInput();
            inputBytes = new byte[expectedLength];
            int offset = 0;
            while (offset < expectedLength)
            {
                int count = input.Read(inputBytes, offset, expectedLength - offset);
                if (count <= 0) return 3;
                offset += count;
            }

            // The bridge promises one exact frame. Refuse a second frame or a
            // mistaken length instead of silently protecting only a prefix.
            if (input.ReadByte() != -1) return 4;

            outputBytes = args[0] == "protect"
                ? ProtectedData.Protect(inputBytes, null, DataProtectionScope.CurrentUser)
                : ProtectedData.Unprotect(inputBytes, null, DataProtectionScope.CurrentUser);

            if (outputBytes == null || outputBytes.Length < 1) return 5;

            Stream output = Console.OpenStandardOutput();
            output.Write(outputBytes, 0, outputBytes.Length);
            output.Flush();
            return 0;
        }
        catch
        {
            return 1;
        }
        finally
        {
            if (inputBytes != null) Array.Clear(inputBytes, 0, inputBytes.Length);
            if (outputBytes != null) Array.Clear(outputBytes, 0, outputBytes.Length);
        }
    }
}
