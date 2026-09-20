#property strict
#property version   "2.00"
#property description "Hearth XAU/USD read-only market + demo risk telemetry bridge"
#property description "Add 127.0.0.1 to MT5 Tools > Options > Expert Advisors allowed addresses."

input string InpHost = "127.0.0.1";
input uint InpPort = 8766;
input ENUM_TIMEFRAMES InpTimeframe = PERIOD_H1;
input int InpBars = 250;
input int InpPushEverySeconds = 2;
input double InpEstimatedSlippagePoints = 2.0;

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
      PrintFormat("Hearth bridge v2: SocketCreate failed, error=%d", GetLastError());
      return false;
     }

   SocketTimeouts(g_socket, 1000, 1000);
   if(!SocketConnect(g_socket, InpHost, InpPort, 1000))
     {
      const int error = GetLastError();
      PrintFormat(
         "Hearth bridge v2: cannot connect to %s:%d, error=%d. Add %s to MT5 allowed addresses and make sure Hearth is running.",
         InpHost,
         InpPort,
         error,
         InpHost
      );
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
      return false;
     }

   PrintFormat("Hearth bridge v2: connected to %s:%d", InpHost, InpPort);
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
      PrintFormat("Hearth bridge v2: SocketSend failed, sent=%d expected=%d error=%d", sent, length, GetLastError());
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
      return false;
     }
   return true;
  }

string AccountTypeLabel()
  {
   const long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(mode == ACCOUNT_TRADE_MODE_DEMO)
      return "demo";
   if(mode == ACCOUNT_TRADE_MODE_REAL)
      return "live";
   return "";
  }

datetime DayStart(const datetime now)
  {
   MqlDateTime parts;
   TimeToStruct(now, parts);
   parts.hour = 0;
   parts.min = 0;
   parts.sec = 0;
   return StructToTime(parts);
  }

string DailyPeakKey(const datetime now)
  {
   MqlDateTime parts;
   TimeToStruct(now, parts);
   return StringFormat("HEARTH_XAU_PEAK_%04d%02d%02d", parts.year, parts.mon, parts.day);
  }

double UpdateDailyPeakEquity(const datetime now)
  {
   const double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   const double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   const string key = DailyPeakKey(now);

   double peak = MathMax(equity, balance);
   if(GlobalVariableCheck(key))
      peak = MathMax(peak, GlobalVariableGet(key));

   GlobalVariableSet(key, peak);
   return peak;
  }

double DailyRealizedLoss(const datetime now)
  {
   if(!HistorySelect(DayStart(now), now))
      return -1.0;

   const int total = HistoryDealsTotal();
   double loss = 0.0;

   for(int index = 0; index < total; index++)
     {
      const ulong ticket = HistoryDealGetTicket(index);
      if(ticket == 0)
         continue;

      const long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT)
         continue;

      const double net =
         HistoryDealGetDouble(ticket, DEAL_PROFIT) +
         HistoryDealGetDouble(ticket, DEAL_COMMISSION) +
         HistoryDealGetDouble(ticket, DEAL_SWAP) +
         HistoryDealGetDouble(ticket, DEAL_FEE);

      if(net < 0.0)
         loss += -net;
     }

   return loss;
  }

bool CalculateOpenRisk(double &openRisk, int &openPositions)
  {
   openRisk = 0.0;
   openPositions = PositionsTotal();

   for(int index = 0; index < openPositions; index++)
     {
      const ulong ticket = PositionGetTicket(index);
      if(ticket == 0)
         return false;

      const string symbol = PositionGetString(POSITION_SYMBOL);
      const double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      const double stopLoss = PositionGetDouble(POSITION_SL);
      const double volume = PositionGetDouble(POSITION_VOLUME);

      if(stopLoss <= 0.0 || volume <= 0.0)
         return false;

      const double tickSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
      double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
      if(tickValue <= 0.0)
         tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);

      if(tickSize <= 0.0 || tickValue <= 0.0)
         return false;

      openRisk += (MathAbs(openPrice - stopLoss) / tickSize) * tickValue * volume;
     }

   return true;
  }

double MarginPerLot(const double ask)
  {
   if(ask <= 0.0)
      return 0.0;

   double margin = 0.0;
   if(!OrderCalcMargin(ORDER_TYPE_BUY, _Symbol, 1.0, ask, margin))
      return 0.0;
   return margin;
  }

string BuildMarketSnapshotJson()
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
      PrintFormat("Hearth bridge v2: CopyRates returned only %d bars for %s", copied, _Symbol);
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

string BuildRiskSnapshotJson()
  {
   const string accountType = AccountTypeLabel();
   if(accountType == "")
     {
      Print("Hearth bridge v2: unsupported account mode for risk telemetry.");
      return "";
     }

   const datetime now = TimeCurrent();
   const double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   const double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   const double peakEquity = UpdateDailyPeakEquity(now);
   const double dailyLoss = DailyRealizedLoss(now);

   if(equity <= 0.0 || freeMargin < 0.0 || peakEquity < equity || dailyLoss < 0.0)
      return "";

   double openRisk = 0.0;
   int openPositions = 0;
   const bool openRiskComplete = CalculateOpenRisk(openRisk, openPositions);

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return "";

   const double pointSize = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   const double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickValue <= 0.0)
      tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);

   const double volumeMin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   const double volumeMax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   const double volumeStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   const double marginPerLot = MarginPerLot(tick.ask);

   if(
      tick.bid <= 0.0 ||
      tick.ask <= 0.0 ||
      pointSize <= 0.0 ||
      tickSize <= 0.0 ||
      tickValue <= 0.0 ||
      volumeMin <= 0.0 ||
      volumeMax < volumeMin ||
      volumeStep <= 0.0 ||
      marginPerLot <= 0.0 ||
      InpEstimatedSlippagePoints < 0.0
   )
      return "";

   return StringFormat(
      "{\"type\":\"risk_snapshot\",\"version\":1,\"canonical_symbol\":\"XAUUSD\",\"broker_symbol\":\"%s\",\"as_of\":%I64d,"
      "\"account\":{\"account_type\":\"%s\",\"currency\":\"%s\",\"equity\":%s,\"peak_equity\":%s,\"free_margin\":%s,"
      "\"daily_realized_loss\":%s,\"open_risk_currency\":%s,\"open_positions\":%d,\"open_risk_complete\":%s},"
      "\"broker\":{\"bid\":%s,\"ask\":%s,\"point_size\":%s,\"tick_size\":%s,\"tick_value_per_lot\":%s,"
      "\"volume_min\":%s,\"volume_max\":%s,\"volume_step\":%s,\"margin_per_lot\":%s,\"estimated_slippage_points\":%s}}",
      JsonEscape(_Symbol),
      (long)now,
      accountType,
      JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)),
      DoubleToString(equity, 2),
      DoubleToString(peakEquity, 2),
      DoubleToString(freeMargin, 2),
      DoubleToString(dailyLoss, 2),
      DoubleToString(openRisk, 2),
      openPositions,
      openRiskComplete ? "true" : "false",
      DoubleToString(tick.bid, _Digits),
      DoubleToString(tick.ask, _Digits),
      DoubleToString(pointSize, _Digits),
      DoubleToString(tickSize, _Digits),
      DoubleToString(tickValue, 8),
      DoubleToString(volumeMin, 8),
      DoubleToString(volumeMax, 8),
      DoubleToString(volumeStep, 8),
      DoubleToString(marginPerLot, 2),
      DoubleToString(InpEstimatedSlippagePoints, 2)
   );
  }

void PushSnapshots()
  {
   const string marketPayload = BuildMarketSnapshotJson();
   if(marketPayload != "")
      SendUtf8Line(marketPayload);

   const string riskPayload = BuildRiskSnapshotJson();
   if(riskPayload != "")
      SendUtf8Line(riskPayload);
  }

int OnInit()
  {
   if(TimeframeLabel(InpTimeframe) == "")
     {
      Print("Hearth bridge v2: unsupported timeframe.");
      return INIT_PARAMETERS_INCORRECT;
     }

   string upperSymbol = _Symbol;
   StringToUpper(upperSymbol);
   if(StringFind(upperSymbol, "XAUUSD") < 0 && StringFind(upperSymbol, "GOLD") < 0)
     {
      Alert("Hearth XAU Bridge V2 must be attached to your broker's XAUUSD/Gold chart.");
      return INIT_PARAMETERS_INCORRECT;
     }

   EventSetTimer(MathMax(1, InpPushEverySeconds));
   PushSnapshots();
   return INIT_SUCCEEDED;
  }

void OnTimer()
  {
   PushSnapshots();
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
