#property strict
#property version   "3.00"
#property description "Hearth XAU/USD demo-only execution bridge"
#property description "DEMO accounts only. Add 127.0.0.1 to MT5 Expert Advisors allowed addresses."

input string InpHost = "127.0.0.1";
input uint InpPort = 8766;
input ENUM_TIMEFRAMES InpTimeframe = PERIOD_H1;
input int InpBars = 250;
input int InpPushEverySeconds = 2;
input double InpEstimatedSlippagePoints = 2.0;

int g_socket = INVALID_HANDLE;
string g_receive_buffer = "";
string g_last_request_id = "";

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
      PrintFormat("Hearth demo executor: SocketCreate failed, error=%d", GetLastError());
      return false;
     }

   SocketTimeouts(g_socket, 1000, 1000);
   if(!SocketConnect(g_socket, InpHost, InpPort, 1000))
     {
      const int error = GetLastError();
      PrintFormat(
         "Hearth demo executor: cannot connect to %s:%d, error=%d.",
         InpHost,
         InpPort,
         error
      );
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
      return false;
     }

   PrintFormat("Hearth demo executor: connected to %s:%d", InpHost, InpPort);
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
      PrintFormat("Hearth demo executor: SocketSend failed, sent=%d expected=%d error=%d", sent, length, GetLastError());
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
      return "";

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
      return "";

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

string BuildExecutorHelloJson()
  {
   const string accountType = AccountTypeLabel();
   if(accountType == "")
      return "";

   return StringFormat(
      "{\"type\":\"executor_hello\",\"version\":1,\"canonical_symbol\":\"XAUUSD\",\"broker_symbol\":\"%s\",\"account_type\":\"%s\",\"as_of\":%I64d}",
      JsonEscape(_Symbol),
      accountType,
      (long)TimeCurrent()
   );
  }

bool ExtractJsonString(const string json, const string key, string &value)
  {
   const string marker = "\"" + key + "\":\"";
   const int start = StringFind(json, marker);
   if(start < 0)
      return false;
   const int valueStart = start + StringLen(marker);
   const int valueEnd = StringFind(json, "\"", valueStart);
   if(valueEnd < 0)
      return false;
   value = StringSubstr(json, valueStart, valueEnd - valueStart);
   return true;
  }

bool ExtractJsonNumber(const string json, const string key, double &value)
  {
   const string marker = "\"" + key + "\":";
   const int start = StringFind(json, marker);
   if(start < 0)
      return false;
   const int valueStart = start + StringLen(marker);
   int valueEnd = StringFind(json, ",", valueStart);
   const int objectEnd = StringFind(json, "}", valueStart);
   if(valueEnd < 0 || (objectEnd >= 0 && objectEnd < valueEnd))
      valueEnd = objectEnd;
   if(valueEnd < 0)
      return false;
   value = StringToDouble(StringSubstr(json, valueStart, valueEnd - valueStart));
   return true;
  }

bool ExtractJsonLong(const string json, const string key, long &value)
  {
   double number = 0.0;
   if(!ExtractJsonNumber(json, key, number))
      return false;
   value = (long)number;
   return true;
  }

ENUM_ORDER_TYPE_FILLING ResolveFillingMode()
  {
   const long filling = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK)
      return ORDER_FILLING_FOK;
   if((filling & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
      return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
  }

bool ExistingRequest(
   const string requestTag,
   ulong &orderTicket,
   ulong &dealTicket,
   ulong &positionTicket,
   double &fillPrice,
   double &volume
)
  {
   const int positions = PositionsTotal();
   for(int index = 0; index < positions; index++)
     {
      const ulong ticket = PositionGetTicket(index);
      if(ticket == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if(StringFind(PositionGetString(POSITION_COMMENT), requestTag) < 0)
         continue;

      positionTicket = ticket;
      fillPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      volume = PositionGetDouble(POSITION_VOLUME);
      return true;
     }

   const datetime now = TimeCurrent();
   if(!HistorySelect(now - 7 * 86400, now))
      return false;

   const int deals = HistoryDealsTotal();
   for(int index = deals - 1; index >= 0; index--)
     {
      const ulong ticket = HistoryDealGetTicket(index);
      if(ticket == 0)
         continue;
      if(HistoryDealGetString(ticket, DEAL_SYMBOL) != _Symbol)
         continue;
      if(StringFind(HistoryDealGetString(ticket, DEAL_COMMENT), requestTag) < 0)
         continue;

      dealTicket = ticket;
      orderTicket = (ulong)HistoryDealGetInteger(ticket, DEAL_ORDER);
      positionTicket = (ulong)HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      fillPrice = HistoryDealGetDouble(ticket, DEAL_PRICE);
      volume = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      return true;
     }

   return false;
  }

void SendReceipt(
   const string requestId,
   const string status,
   const uint retcode,
   const string reason,
   const ulong orderTicket,
   const ulong dealTicket,
   const ulong positionTicket,
   const double fillPrice,
   const double volume,
   const double stopLoss,
   const double takeProfit
)
  {
   const string payload = StringFormat(
      "{\"type\":\"execution_receipt\",\"version\":1,\"request_id\":\"%s\",\"status\":\"%s\",\"account_type\":\"%s\","
      "\"retcode\":%u,\"reason\":\"%s\",\"order_ticket\":\"%I64u\",\"deal_ticket\":\"%I64u\",\"position_ticket\":\"%I64u\","
      "\"fill_price\":%s,\"volume\":%s,\"stop_loss\":%s,\"take_profit\":%s,\"as_of\":%I64d}",
      JsonEscape(requestId),
      JsonEscape(status),
      JsonEscape(AccountTypeLabel()),
      retcode,
      JsonEscape(reason),
      orderTicket,
      dealTicket,
      positionTicket,
      DoubleToString(fillPrice, _Digits),
      DoubleToString(volume, 8),
      DoubleToString(stopLoss, _Digits),
      DoubleToString(takeProfit, _Digits),
      (long)TimeCurrent()
   );
   SendUtf8Line(payload);
  }

void RejectCommand(const string requestId, const uint retcode, const string reason)
  {
   SendReceipt(requestId, "REJECTED", retcode, reason, 0, 0, 0, 0.0, 0.0, 0.0, 0.0);
  }

void ExecuteDemoCommand(const string json)
  {
   string requestId = "";
   string requestTag = "";
   string side = "";
   string canonicalSymbol = "";
   double volume = 0.0;
   double referencePrice = 0.0;
   double stopLoss = 0.0;
   double takeProfit = 0.0;
   double deviationValue = 0.0;
   long expiresEpoch = 0;

   if(
      !ExtractJsonString(json, "request_id", requestId) ||
      !ExtractJsonString(json, "request_tag", requestTag) ||
      !ExtractJsonString(json, "canonical_symbol", canonicalSymbol) ||
      !ExtractJsonString(json, "side", side) ||
      !ExtractJsonNumber(json, "volume", volume) ||
      !ExtractJsonNumber(json, "reference_price", referencePrice) ||
      !ExtractJsonNumber(json, "stop_loss", stopLoss) ||
      !ExtractJsonNumber(json, "take_profit", takeProfit) ||
      !ExtractJsonNumber(json, "max_deviation_points", deviationValue) ||
      !ExtractJsonLong(json, "expires_epoch", expiresEpoch)
   )
     {
      if(requestId != "")
         RejectCommand(requestId, 0, "invalid_command");
      return;
     }

   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_DEMO)
     {
      RejectCommand(requestId, 0, "demo_account_required");
      return;
     }

   if(TimeCurrent() > (datetime)expiresEpoch)
     {
      RejectCommand(requestId, 0, "command_expired");
      return;
     }

   if(canonicalSymbol != "XAUUSD" || (side != "BUY" && side != "SELL"))
     {
      RejectCommand(requestId, 0, "command_identity_invalid");
      return;
     }

   if(StringFind(requestTag, "HRT8_") != 0 || StringLen(requestTag) != 17)
     {
      RejectCommand(requestId, 0, "request_tag_invalid");
      return;
     }

   ulong existingOrder = 0;
   ulong existingDeal = 0;
   ulong existingPosition = 0;
   double existingPrice = 0.0;
   double existingVolume = 0.0;
   if(requestId == g_last_request_id || ExistingRequest(requestTag, existingOrder, existingDeal, existingPosition, existingPrice, existingVolume))
     {
      SendReceipt(
         requestId,
         "DUPLICATE",
         0,
         "already_seen",
         existingOrder,
         existingDeal,
         existingPosition,
         existingPrice > 0.0 ? existingPrice : referencePrice,
         existingVolume > 0.0 ? existingVolume : volume,
         stopLoss,
         takeProfit
      );
      return;
     }

   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
     {
      RejectCommand(requestId, 0, "terminal_trading_not_allowed");
      return;
     }

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
     {
      RejectCommand(requestId, 0, "quote_unavailable");
      return;
     }

   const double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   const double volumeMin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   const double volumeMax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   const double volumeStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   const int stopsLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);

   if(point <= 0.0 || volumeMin <= 0.0 || volumeMax < volumeMin || volumeStep <= 0.0)
     {
      RejectCommand(requestId, 0, "broker_metadata_invalid");
      return;
     }

   if(volume < volumeMin - 1e-8 || volume > volumeMax + 1e-8)
     {
      RejectCommand(requestId, 0, "volume_out_of_bounds");
      return;
     }

   const double stepCount = (volume - volumeMin) / volumeStep;
   if(MathAbs(stepCount - MathRound(stepCount)) > 1e-6)
     {
      RejectCommand(requestId, 0, "volume_step_invalid");
      return;
     }

   const double price = side == "BUY" ? tick.ask : tick.bid;
   const int deviation = (int)MathRound(deviationValue);
   if(deviation < 0 || deviation > 100)
     {
      RejectCommand(requestId, 0, "deviation_invalid");
      return;
     }

   if(MathAbs(price - referencePrice) > deviation * point + 1e-8)
     {
      RejectCommand(requestId, 0, "price_moved_beyond_deviation");
      return;
     }

   const double minimumStopDistance = stopsLevel * point;
   if(side == "BUY")
     {
      if(stopLoss >= price || takeProfit <= price ||
         price - stopLoss < minimumStopDistance ||
         takeProfit - price < minimumStopDistance)
        {
         RejectCommand(requestId, 0, "stop_target_invalid");
         return;
        }
     }
   else
     {
      if(stopLoss <= price || takeProfit >= price ||
         stopLoss - price < minimumStopDistance ||
         price - takeProfit < minimumStopDistance)
        {
         RejectCommand(requestId, 0, "stop_target_invalid");
         return;
        }
     }

   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   MqlTradeCheckResult check = {};

   request.action = TRADE_ACTION_DEAL;
   request.magic = 882208;
   request.symbol = _Symbol;
   request.volume = volume;
   request.type = side == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   request.price = price;
   request.sl = NormalizeDouble(stopLoss, _Digits);
   request.tp = NormalizeDouble(takeProfit, _Digits);
   request.deviation = (ulong)deviation;
   request.type_filling = ResolveFillingMode();
   request.type_time = ORDER_TIME_GTC;
   request.comment = requestTag;

   if(!OrderCheck(request, check))
     {
      RejectCommand(requestId, check.retcode, "order_check_failed:" + check.comment);
      return;
     }

   ResetLastError();
   if(!OrderSend(request, result))
     {
      RejectCommand(requestId, result.retcode, "order_send_failed:" + result.comment);
      return;
     }

   if(result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_DONE_PARTIAL)
     {
      RejectCommand(requestId, result.retcode, "order_not_filled:" + result.comment);
      return;
     }

   g_last_request_id = requestId;
   SendReceipt(
      requestId,
      "FILLED",
      result.retcode,
      result.comment,
      result.order,
      result.deal,
      0,
      result.price,
      result.volume,
      request.sl,
      request.tp
   );
  }

void ProcessIncomingCommands()
  {
   if(g_socket == INVALID_HANDLE || !SocketIsConnected(g_socket))
      return;

   while(true)
     {
      const uint available = SocketIsReadable(g_socket);
      if(available == 0)
         break;

      const uint toRead = (uint)MathMin((double)available, 8192.0);
      uchar data[];
      const int read = SocketRead(g_socket, data, toRead, 1);
      if(read <= 0)
         break;

      g_receive_buffer += CharArrayToString(data, 0, read, CP_UTF8);

      while(true)
        {
         const int newline = StringFind(g_receive_buffer, "\n");
         if(newline < 0)
            break;

         const string line = StringSubstr(g_receive_buffer, 0, newline);
         g_receive_buffer = StringSubstr(g_receive_buffer, newline + 1);

         if(StringFind(line, "\"type\":\"demo_order\"") >= 0)
            ExecuteDemoCommand(line);
        }

      if(StringLen(g_receive_buffer) > 131072)
        {
         g_receive_buffer = "";
         break;
        }
     }
  }

void PushSnapshotsAndHello()
  {
   const string marketPayload = BuildMarketSnapshotJson();
   if(marketPayload != "")
      SendUtf8Line(marketPayload);

   const string riskPayload = BuildRiskSnapshotJson();
   if(riskPayload != "")
      SendUtf8Line(riskPayload);

   const string helloPayload = BuildExecutorHelloJson();
   if(helloPayload != "")
      SendUtf8Line(helloPayload);
  }

int OnInit()
  {
   if(TimeframeLabel(InpTimeframe) == "")
     {
      Print("Hearth demo executor: unsupported timeframe.");
      return INIT_PARAMETERS_INCORRECT;
     }

   string upperSymbol = _Symbol;
   StringToUpper(upperSymbol);
   if(StringFind(upperSymbol, "XAUUSD") < 0 && StringFind(upperSymbol, "GOLD") < 0)
     {
      Alert("Hearth XAU Demo Executor must be attached to your broker's XAUUSD/Gold chart.");
      return INIT_PARAMETERS_INCORRECT;
     }

   EventSetTimer(MathMax(1, InpPushEverySeconds));
   PushSnapshotsAndHello();
   ProcessIncomingCommands();
   return INIT_SUCCEEDED;
  }

void OnTimer()
  {
   PushSnapshotsAndHello();
   ProcessIncomingCommands();
  }

void OnTick()
  {
   ProcessIncomingCommands();
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
