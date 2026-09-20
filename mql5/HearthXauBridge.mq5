#property strict
#property version   "1.00"
#property description "Hearth XAU/USD read-only market-data bridge"
#property description "Add 127.0.0.1 to MT5 Tools > Options > Expert Advisors allowed addresses."

input string InpHost = "127.0.0.1";
input uint InpPort = 8766;
input ENUM_TIMEFRAMES InpTimeframe = PERIOD_H1;
input int InpBars = 250;
input int InpPushEverySeconds = 2;

int g_socket = INVALID_HANDLE;

string TimeframeLabel(const ENUM_TIMEFRAMES timeframe)
  {
   switch(timeframe)
     {
      case PERIOD_M1:  return "M1";
      case PERIOD_M5:  return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_M30: return "M30";
      case PERIOD_H1:  return "H1";
      case PERIOD_H4:  return "H4";
      case PERIOD_D1:  return "D1";
      default:         return "";
     }
  }

string JsonEscape(string value)
  {
   const string slash = CharToString((uchar)92);
   const string quote = CharToString((uchar)34);
   StringReplace(value, slash, slash + slash);
   StringReplace(value, quote, slash + quote);
   StringReplace(value, "\r", "");
   StringReplace(value, "\n", " ");
   return value;
  }

bool EnsureSocket()
  {
   if(g_socket != INVALID_HANDLE && SocketIsConnected(g_socket))
      return true;

   if(g_socket != INVALID_HANDLE)
     {
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
     }

   ResetLastError();
   g_socket = SocketCreate(SOCKET_DEFAULT);
   if(g_socket == INVALID_HANDLE)
     {
      PrintFormat("Hearth bridge: SocketCreate failed, error=%d", GetLastError());
      return false;
     }

   SocketTimeouts(g_socket, 1000, 1000);
   if(!SocketConnect(g_socket, InpHost, InpPort, 1000))
     {
      const int error = GetLastError();
      PrintFormat(
         "Hearth bridge: cannot connect to %s:%d, error=%d. Add %s to MT5 allowed addresses and make sure Hearth is running.",
         InpHost,
         InpPort,
         error,
         InpHost
      );
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
      return false;
     }

   PrintFormat("Hearth bridge: connected to %s:%d", InpHost, InpPort);
   return true;
  }

bool SendUtf8Line(const string text)
  {
   if(!EnsureSocket())
      return false;

   uchar data[];
   const int length = StringToCharArray(text + "\n", data, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   if(length <= 0)
      return false;

   ResetLastError();
   const int sent = SocketSend(g_socket, data, (uint)length);
   if(sent != length)
     {
      PrintFormat("Hearth bridge: SocketSend failed, sent=%d expected=%d error=%d", sent, length, GetLastError());
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
      return false;
     }
   return true;
  }

string BuildSnapshotJson()
  {
   const string timeframe = TimeframeLabel(InpTimeframe);
   if(timeframe == "")
      return "";

   const int requested = MathMax(20, MathMin(500, InpBars));
   MqlRates rates[];
   ArraySetAsSeries(rates, true);

   const int copied = CopyRates(_Symbol, InpTimeframe, 0, requested, rates);
   if(copied < 20)
     {
      PrintFormat("Hearth bridge: CopyRates returned only %d bars for %s", copied, _Symbol);
      return "";
     }

   string json = StringFormat(
      "{\"type\":\"snapshot\",\"version\":1,\"canonical_symbol\":\"XAUUSD\",\"broker_symbol\":\"%s\",\"timeframe\":\"%s\",\"as_of\":%I64d,\"bars\":[",
      JsonEscape(_Symbol),
      timeframe,
      (long)TimeCurrent()
   );

   for(int index = copied - 1; index >= 0; index--)
     {
      if(index != copied - 1)
         json += ",";

      json += StringFormat(
         "{\"time\":%I64d,\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s,\"volume\":%I64d}",
         (long)rates[index].time,
         DoubleToString(rates[index].open, _Digits),
         DoubleToString(rates[index].high, _Digits),
         DoubleToString(rates[index].low, _Digits),
         DoubleToString(rates[index].close, _Digits),
         (long)rates[index].tick_volume
      );
     }

   json += "]}";
   return json;
  }

void PushSnapshot()
  {
   const string payload = BuildSnapshotJson();
   if(payload == "")
      return;
   SendUtf8Line(payload);
  }

int OnInit()
  {
   if(TimeframeLabel(InpTimeframe) == "")
     {
      Print("Hearth bridge: unsupported timeframe.");
      return INIT_PARAMETERS_INCORRECT;
     }

   string upperSymbol = _Symbol;
   StringToUpper(upperSymbol);
   if(StringFind(upperSymbol, "XAUUSD") < 0 && StringFind(upperSymbol, "GOLD") < 0)
     {
      Alert("Hearth XAU Bridge must be attached to your broker's XAUUSD/Gold chart.");
      return INIT_PARAMETERS_INCORRECT;
     }

   EventSetTimer(MathMax(1, InpPushEverySeconds));
   PushSnapshot();
   return INIT_SUCCEEDED;
  }

void OnTimer()
  {
   PushSnapshot();
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_socket != INVALID_HANDLE)
     {
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
     }
  }