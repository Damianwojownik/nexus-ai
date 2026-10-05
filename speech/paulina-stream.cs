using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

public static class PaulinaStreamWorker
{
    const string Voice = "Microsoft Paulina Desktop";
    static readonly object Gate = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    static Utterance Active;
    sealed class Utterance : IDisposable
    {
        public string Id;
        public int Samples, Chunks, Phonemes, Visemes;
        public double? FirstPcm;
        public Exception Error;
        public readonly Stopwatch Clock = Stopwatch.StartNew();
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim();
        public void Dispose() { Done.Dispose(); }
    }
    static Dictionary<string, object> Packet(string type, string id)
    {
        var p = new Dictionary<string, object> { { "type", type } };
        if (type != "ready") p["requestId"] = id;
        return p;
    }
    static void Format(Dictionary<string, object> p)
    {
        p["encoding"] = "PCM16LE"; p["sampleRate"] = 16000;
        p["channels"] = 1; p["bitsPerSample"] = 16;
    }
    static void Identity(Dictionary<string, object> p)
    {
        p["voice"] = Voice; p["language"] = "pl-PL"; p["cost"] = 0; p["device"] = "cpu";
        Format(p);
    }
    static void Emit(Dictionary<string, object> p)
    {
        lock (Gate) { Console.Out.WriteLine(Json.Serialize(p)); Console.Out.Flush(); }
    }
    static void Ready(bool available, string reason)
    {
        var p = Packet("ready", null); Identity(p);
        p["available"] = available; p["pcm"] = available; p["reason"] = reason; Emit(p);
    }
    sealed class PcmSink : Stream
    {
        readonly byte[] Buffer = new byte[640]; // Exactly 20 ms; only the final packet may be shorter.
        readonly SHA256 Hash = SHA256.Create();
        int Used;
        long Written;
        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { return Written; } }
        // System.Speech queries Position even for a non-seekable raw output stream.
        public override long Position { get { return Written; } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override int Read(byte[] b, int o, int n) { throw new NotSupportedException(); }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long n) { throw new NotSupportedException(); }
        public override void Write(byte[] b, int offset, int count)
        {
            Written += count;
            while (count > 0)
            {
                int n = Math.Min(count, Buffer.Length - Used);
                System.Buffer.BlockCopy(b, offset, Buffer, Used, n);
                Used += n; offset += n; count -= n;
                if (Used == Buffer.Length) Send();
            }
        }
        void Send()
        {
            if (Used == 0) return;
            if ((Used & 1) != 0) throw new IOException("Unaligned PCM.");
            lock (Gate)
            {
                var u = Active;
                if (u == null || u.Samples + Used / 2 > 28800000) throw new IOException("PCM limit exceeded.");
                if (!u.FirstPcm.HasValue) u.FirstPcm = u.Clock.Elapsed.TotalMilliseconds;
                var p = Packet("audio", u.Id); Format(p);
                p["sequence"] = u.Chunks++; p["startSample"] = u.Samples; p["sampleCount"] = Used / 2;
                p["bytesBase64"] = Convert.ToBase64String(Buffer, 0, Used);
                p["sha256"] = BitConverter.ToString(Hash.ComputeHash(Buffer, 0, Used)).Replace("-", "").ToLowerInvariant();
                u.Samples += Used / 2; Emit(p); Used = 0;
            }
        }
        public void Finish() { Send(); }
        protected override void Dispose(bool disposing) { if (disposing) Hash.Dispose(); base.Dispose(disposing); }
    }
    static void Phoneme(object sender, PhonemeReachedEventArgs e)
    {
        lock (Gate)
        {
            if (Active == null) return;
            var p = Packet("phoneme", Active.Id);
            p["source"] = "System.Speech.PhonemeReached"; p["symbol"] = e.Phoneme;
            p["nextSymbol"] = e.NextPhoneme ?? "";
            // SAPI tokens are not clinical phoneme segmentation: preserve modifiers and boundaries verbatim.
            p["kind"] = e.Phoneme == "\u0004" ? "boundary" :
                Regex.IsMatch(e.Phoneme, @"^[\p{M}\p{Lm}]+$") ? "modifier" : "native-token";
            p["audioPositionMs"] = e.AudioPosition.TotalMilliseconds;
            p["durationMs"] = e.Duration.TotalMilliseconds; p["emphasis"] = (int)e.Emphasis;
            Active.Phonemes++; Emit(p);
        }
    }
    static void Viseme(object sender, VisemeReachedEventArgs e)
    {
        lock (Gate)
        {
            if (Active == null) return;
            var p = Packet("viseme", Active.Id);
            p["source"] = "System.Speech.VisemeReached"; p["viseme"] = e.Viseme; p["nextViseme"] = e.NextViseme;
            p["audioPositionMs"] = e.AudioPosition.TotalMilliseconds;
            p["durationMs"] = e.Duration.TotalMilliseconds; p["emphasis"] = (int)e.Emphasis;
            Active.Visemes++; Emit(p);
        }
    }
    static string ReadRequest()
    {
        var line = new StringBuilder();
        for (int ch; (ch = Console.In.Read()) != -1;)
        {
            if (ch == '\n') return line.ToString().TrimEnd('\r');
            if (line.Length >= 65536) throw new IOException("Request too large.");
            line.Append((char)ch);
        }
        return line.Length == 0 ? null : line.ToString();
    }
    public static void Run()
    {
        Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        using (var synth = new SpeechSynthesizer())
        using (var sink = new PcmSink())
        {
            bool installed = false;
            foreach (var v in synth.GetInstalledVoices())
                if (v.Enabled && v.VoiceInfo.Name == Voice && v.VoiceInfo.Culture.Name == "pl-PL"
                    && v.VoiceInfo.Gender == VoiceGender.Female) installed = true;
            if (!installed) { Ready(false, "Microsoft Paulina Desktop/pl-PL is not installed."); return; }
            synth.SelectVoice(Voice);
            synth.SetOutputToAudioStream(sink, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            synth.PhonemeReached += Phoneme; synth.VisemeReached += Viseme;
            synth.SpeakCompleted += delegate(object sender, SpeakCompletedEventArgs e)
            {
                var u = Active;
                if (u != null) { u.Error = e.Error ?? (e.Cancelled ? new OperationCanceledException() : null); u.Done.Set(); }
            };
            Ready(true, null);
            for (string line; (line = ReadRequest()) != null;)
            {
                string id = null;
                try
                {
                    var request = Json.Deserialize<Dictionary<string, object>>(line);
                    object value;
                    if (request == null || !request.TryGetValue("requestId", out value) || !(value is string)
                        || !Regex.IsMatch((string)value, @"^[A-Za-z0-9_-]{1,80}$")) throw new ArgumentException();
                    id = (string)value;
                    if (request.Count != 3 || !request.ContainsKey("type") || !Equals(request["type"], "speak")
                        || !request.TryGetValue("text", out value) || !(value is string)) throw new ArgumentException();
                    var text = (string)value;
                    if (String.IsNullOrWhiteSpace(text) || text.Length > 6000) throw new ArgumentException();
                    using (var u = new Utterance { Id = id })
                    {
                        Active = u;
                        var start = Packet("start", id); Identity(start); Emit(start);
                        synth.SpeakAsync(text); u.Done.Wait();
                        if (u.Error != null) throw new IOException("Synthesis failed.", u.Error);
                        sink.Finish();
                        if (u.Samples == 0) throw new IOException("Empty PCM.");
                        var end = Packet("end", id);
                        end["totalSamples"] = u.Samples; end["chunks"] = u.Chunks;
                        end["phonemes"] = u.Phonemes; end["visemes"] = u.Visemes;
                        end["audioDurationMs"] = u.Samples / 16.0;
                        end["synthesisMs"] = u.Clock.Elapsed.TotalMilliseconds; end["firstPcmMs"] = u.FirstPcm;
                        Emit(end); Active = null;
                    }
                }
                catch (Exception e)
                {
                    var p = Packet("error", id);
                    p["code"] = Active == null && e is ArgumentException ? "INVALID_REQUEST" : "SYNTHESIS_FAILED";
                    p["message"] = "Paulina request failed; no alternate voice was used."; Emit(p);
                    Active = null; return;
                }
            }
        }
    }
}
