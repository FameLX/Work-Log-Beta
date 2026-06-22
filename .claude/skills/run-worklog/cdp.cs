using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.IO;

public class CDP {
    static ClientWebSocket ws;
    static CancellationToken ct = CancellationToken.None;
    static int msgId = 1;

    public static void Main(string[] args) {
        ws = new ClientWebSocket();
        ws.ConnectAsync(new Uri(args[0]), ct).Wait();

        string op = args.Length > 1 ? args[1] : "screenshot";
        string outFile = args.Length > 2 ? args[2] : @"C:\Temp\worklog-screenshot.png";
        string expr = args.Length > 3 ? args[3] : "";
        string val = args.Length > 4 ? args[4] : "";

        if (op == "screenshot") {
            Screenshot(outFile);
        } else if (op == "eval") {
            Console.WriteLine(Eval(expr));
        } else if (op == "click") {
            Eval("document.querySelector('" + expr + "').click()");
            Console.WriteLine("clicked");
        } else if (op == "set") {
            string js = "(function(){var el=document.querySelector('" + expr + "');el.value='" + val.Replace("'", "\\'") + "';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()";
            Eval(js);
            Console.WriteLine("set");
        }

        ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", ct).Wait();
    }

    static string SendRecv(string msg) {
        byte[] bytes = Encoding.UTF8.GetBytes(msg);
        ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct).Wait();
        MemoryStream ms = new MemoryStream();
        byte[] buf = new byte[2097152];
        WebSocketReceiveResult result;
        do {
            result = ws.ReceiveAsync(new ArraySegment<byte>(buf), ct).GetAwaiter().GetResult();
            ms.Write(buf, 0, result.Count);
        } while (!result.EndOfMessage);
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    static string Eval(string expression) {
        string escaped = expression.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "");
        string cmd = "{\"id\":" + msgId.ToString() + ",\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"" + escaped + "\",\"returnByValue\":true}}";
        msgId++;
        string resp = SendRecv(cmd);
        int vi = resp.IndexOf("\"value\":");
        if (vi < 0) return resp;
        int start = vi + 8;
        if (start >= resp.Length) return "";
        char first = resp[start];
        if (first == '"') {
            int end = resp.IndexOf('"', start + 1);
            if (end < 0) return resp.Substring(start + 1);
            return resp.Substring(start + 1, end - start - 1);
        }
        int end2 = resp.IndexOfAny(new char[]{',', '}', ']'}, start);
        if (end2 < 0) return resp.Substring(start);
        return resp.Substring(start, end2 - start);
    }

    static void Screenshot(string path) {
        string cmd = "{\"id\":" + msgId.ToString() + ",\"method\":\"Page.captureScreenshot\",\"params\":{\"format\":\"png\"}}";
        msgId++;
        string resp = SendRecv(cmd);
        int start = resp.IndexOf("\"data\":\"") + 8;
        int end = resp.IndexOf('"', start);
        string b64 = resp.Substring(start, end - start);
        File.WriteAllBytes(path, Convert.FromBase64String(b64));
        Console.WriteLine("screenshot:" + path);
    }
}
