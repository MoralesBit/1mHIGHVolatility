import React, { useState, useEffect, useCallback } from 'react';

// --- Configuration (IMPORTANT: Move to backend/environment variables) ---
const TELEGRAM_BOT_TOKEN = '5028180661:AAHM9j4jxsU_bCLpxbNjOtP5DIAT_UgUs-s'; // Replace with your bot token (DO NOT COMMIT THIS)
const TELEGRAM_CHAT_ID = '-1001721640586'; // Replace with your chat ID (DO NOT COMMIT THIS)
// ---------------------------------------------------------------------

const EMA_PERIOD_SHORT = 59;
const EMA_PERIOD_LONG = 200;
const BBW_PERIOD = 20;
const ADX_PERIOD = 14; // Standard period for ADX
const KLINE_INTERVAL = '1m'; // Consider '1h' or '4h' for more meaningful long-term EMAs
// Fetch enough data for EMA200 + ADX lookback + buffer
const KLINE_LIMIT = EMA_PERIOD_LONG + ADX_PERIOD + 50;
// const DISTANCE_THRESHOLD_PERCENT = 1.65; // <-- REMOVED: Now managed by state
const BBW_THRESHOLD = 1.0;
const REFRESH_INTERVAL_MS = 60000; // Interval for refreshing data (60 seconds)

interface TickerData {
    symbol: string;
    priceChangePercent: string;
    lastPrice: string;
}

// Combined data structure for analysis results
interface TickerAnalysisData {
    symbol: string;
    bbwPercentage: number | null;
    emaShort: number | null;
    emaLong: number | null;
    emaDistancePercent: number | null;
    adx: number | null;
    plusDI: number | null;
    minusDI: number | null;
    adxSignal: 'LONG' | 'SHORT' | null;
    alertSignal: 'LONG' | 'SHORT' | null;
}

// --- Helper Functions ---

// Function to calculate EMA
const calculateEMA = (data: number[], period: number): number | null => {
    if (data.length < period) {
        return null;
    }
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    for (let i = period; i < data.length; i++) {
        ema = (data[i] * k) + (ema * (1 - k));
    }
    return ema;
};

// Function to calculate Bollinger Bandwidth Percentage
const calculateBollingerBandwidthPercentage = (closes: number[], period: number): number | null => {
    if (closes.length < period) return null;
    const relevantCloses = closes.slice(-period);
    const sum = relevantCloses.reduce((acc, price) => acc + price, 0);
    const mean = sum / period;
    if (mean === 0) return null;
    const squaredDifferences = relevantCloses.map(price => Math.pow(price - mean, 2));
    const variance = squaredDifferences.reduce((acc, diff) => acc + diff, 0) / period;
    const standardDeviation = Math.sqrt(variance);
    const upperBand = mean + 2 * standardDeviation;
    const lowerBand = mean - 2 * standardDeviation;
    const bandwidth = upperBand - lowerBand;
    const percentageBandwidth = (bandwidth / mean) * 100;
    return percentageBandwidth;
};

// Function to calculate ADX, +DI, -DI
const calculateADX = (highs: number[], lows: number[], closes: number[], period: number): { adx: number | null, plusDI: number | null, minusDI: number | null } => {
    if (highs.length < period * 2) {
        return { adx: null, plusDI: null, minusDI: null };
    }

    const trValues: number[] = [];
    const plusDMValues: number[] = [];
    const minusDMValues: number[] = [];

    for (let i = 1; i < highs.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevHigh = highs[i - 1];
        const prevLow = lows[i - 1];
        const prevClose = closes[i - 1];

        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        const tr = Math.max(tr1, tr2, tr3);
        trValues.push(tr);

        const upMove = high - prevHigh;
        const downMove = prevLow - low;

        const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
        const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;
        plusDMValues.push(plusDM);
        minusDMValues.push(minusDM);
    }

    if (trValues.length < period || plusDMValues.length < period || minusDMValues.length < period) {
        return { adx: null, plusDI: null, minusDI: null };
    }

    const smoothSeries = (values: number[], smoothingPeriod: number): number[] => {
        if (values.length < smoothingPeriod) return [];
        const smoothed: number[] = [];
        let currentSmoothedValue = values.slice(0, smoothingPeriod).reduce((sum, val) => sum + val, 0) / smoothingPeriod;
        smoothed.push(currentSmoothedValue);
        const k = 2 / (smoothingPeriod + 1);
        for (let i = smoothingPeriod; i < values.length; i++) {
            currentSmoothedValue = (values[i] * k) + (currentSmoothedValue * (1 - k));
            smoothed.push(currentSmoothedValue);
        }
        return smoothed;
    };

    const smoothedTR = smoothSeries(trValues, period);
    const smoothedPlusDM = smoothSeries(plusDMValues, period);
    const smoothedMinusDM = smoothSeries(minusDMValues, period);

    if (smoothedTR.length === 0 || smoothedPlusDM.length === 0 || smoothedMinusDM.length === 0) {
         return { adx: null, plusDI: null, minusDI: null };
    }

    const plusDIValues: number[] = [];
    const minusDIValues: number[] = [];
    const dxValues: number[] = [];

    for (let i = 0; i < smoothedTR.length; i++) {
        const atr = smoothedTR[i];
        if (atr === 0) {
            plusDIValues.push(0);
            minusDIValues.push(0);
            dxValues.push(0);
            continue;
        }
        const plusDI = 100 * (smoothedPlusDM[i] / atr);
        const minusDI = 100 * (smoothedMinusDM[i] / atr);
        plusDIValues.push(plusDI);
        minusDIValues.push(minusDI);
        const diSum = plusDI + minusDI;
        const dx = (diSum === 0) ? 0 : 100 * (Math.abs(plusDI - minusDI) / diSum);
        dxValues.push(dx);
    }

    if (dxValues.length < period) {
        const lastPlusDI = plusDIValues.length > 0 ? plusDIValues[plusDIValues.length - 1] : null;
        const lastMinusDI = minusDIValues.length > 0 ? minusDIValues[minusDIValues.length - 1] : null;
        return { adx: null, plusDI: lastPlusDI, minusDI: lastMinusDI };
    }

    const adxSmoothed = smoothSeries(dxValues, period);
    const finalADX = adxSmoothed.length > 0 ? adxSmoothed[adxSmoothed.length - 1] : null;
    const finalPlusDI = plusDIValues.length > 0 ? plusDIValues[plusDIValues.length - 1] : null;
    const finalMinusDI = minusDIValues.length > 0 ? minusDIValues[minusDIValues.length - 1] : null;

    return { adx: finalADX, plusDI: finalPlusDI, minusDI: finalMinusDI };
};


// Function to send Telegram Alert
const sendTelegramAlert = async (message: string): Promise<void> => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || TELEGRAM_BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') {
        console.warn('Telegram Bot Token or Chat ID not configured or using default. Skipping alert.');
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' };
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorData = await response.json();
            console.error(`Failed to send Telegram message for: ${message.substring(0, 50)}... Status: ${response.status}`, errorData);
        } else {
            console.log(`Telegram alert sent successfully: ${message.substring(0, 50)}...`);
        }
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
};

// --- Custom Hook for Binance Ticker Data ---
const useBinanceTickers = () => {
    const [tickers, setTickers] = useState<TickerData[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchTickers = useCallback(async (isInitialLoad = false) => {
        if (!isInitialLoad) console.log(`Refreshing tickers (${new Date().toLocaleTimeString()})...`);
        else console.log("Fetching initial tickers...");
        if (isInitialLoad) setLoading(true);
        setError(null);

        try {
            const response = await fetch('https://api.binance.com/api/v3/ticker/24hr');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data: any[] = await response.json();
            const usdtTickers = data
                .filter(ticker => ticker.symbol?.endsWith('USDT') && parseFloat(ticker.lastPrice) > 0)
                .map(ticker => ({
                    symbol: ticker.symbol,
                    priceChangePercent: ticker.priceChangePercent,
                    lastPrice: ticker.lastPrice,
                }));
            const highVolatilityTickers = usdtTickers.filter(
                ticker => Math.abs(parseFloat(ticker.priceChangePercent)) > 5
            );
            if (isInitialLoad || highVolatilityTickers.length !== tickers.length) {
                 console.log(`Found ${highVolatilityTickers.length} high volatility USDT tickers.`);
            }
            setTickers(highVolatilityTickers);
        } catch (e: any) {
            console.error("Error fetching tickers:", e);
            setError(e.message);
        } finally {
            if (isInitialLoad) setLoading(false);
        }
    }, [tickers.length]);

    useEffect(() => {
        fetchTickers(true); // Initial fetch
        const intervalId = setInterval(() => fetchTickers(false), REFRESH_INTERVAL_MS);
        return () => {
            console.log("Clearing ticker fetch interval.");
            clearInterval(intervalId);
        };
    }, [fetchTickers]);

    return { tickers, loading, error };
};

// --- Main App Component ---
const App: React.FC = () => {
    const { tickers, loading: tickersLoading, error: tickersError } = useBinanceTickers();
    const [analysisData, setAnalysisData] = useState<TickerAnalysisData[]>([]);
    const [analysisLoading, setAnalysisLoading] = useState(false);
    const [analysisError, setAnalysisError] = useState<string | null>(null);
    const [lastAnalysisTime, setLastAnalysisTime] = useState<Date | null>(null);
    const [sentAlerts, setSentAlerts] = useState<Record<string, 'LONG' | 'SHORT'>>({});

    // --- STATE FOR ADJUSTABLE THRESHOLD ---
    const [distanceThreshold, setDistanceThreshold] = useState<number>(1.65); // Default value

    // --- HANDLER FOR THRESHOLD INPUT CHANGE ---
    const handleThresholdChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = parseFloat(event.target.value);
        // Set to 0 if parsing fails or input is empty
        setDistanceThreshold(isNaN(newValue) ? 0 : newValue);
    };

    // --- UPDATED analyzeTicker to use state variable ---
    const analyzeTicker = useCallback(async (ticker: TickerData): Promise<TickerAnalysisData | null> => {
        const symbol = ticker.symbol;
        try {
            const klinesResponse = await fetch(
                `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${KLINE_INTERVAL}&limit=${KLINE_LIMIT}`
            );
            if (!klinesResponse.ok) {
                if (klinesResponse.status === 429 || klinesResponse.status === 418) console.warn(`Rate limited/banned for ${symbol}. Status: ${klinesResponse.status}`);
                else console.error(`Failed klines fetch for ${symbol}: ${klinesResponse.status}`);
                return null;
            }
            const klinesData: (string | number)[][] = await klinesResponse.json();

            if (!Array.isArray(klinesData) || klinesData.length < Math.max(EMA_PERIOD_LONG, BBW_PERIOD, ADX_PERIOD * 2)) {
                return null;
            }

            const highs = klinesData.map(kline => parseFloat(kline[2].toString())).filter(val => !isNaN(val));
            const lows = klinesData.map(kline => parseFloat(kline[3].toString())).filter(val => !isNaN(val));
            const closes = klinesData.map(kline => parseFloat(kline[4].toString())).filter(val => !isNaN(val));

             const minLengthRequired = Math.max(EMA_PERIOD_LONG, BBW_PERIOD, ADX_PERIOD * 2);
             if (closes.length < minLengthRequired || highs.length !== closes.length || lows.length !== closes.length) {
                  console.warn(`Insufficient/mismatched valid OHLC data for ${symbol} after filtering.`);
                  return null;
             }

            const emaShort = calculateEMA(closes, EMA_PERIOD_SHORT);
            const emaLong = calculateEMA(closes, EMA_PERIOD_LONG);
            const bbwPercentage = calculateBollingerBandwidthPercentage(closes, BBW_PERIOD);
            const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, ADX_PERIOD);

            let emaDistancePercent: number | null = null;
            if (emaShort !== null && emaLong !== null && emaLong !== 0) {
                emaDistancePercent = ((emaShort - emaLong) / emaLong) * 100;
            }

            let alertSignal: 'LONG' | 'SHORT' | null = null;
            if (bbwPercentage !== null && bbwPercentage <= BBW_THRESHOLD && emaDistancePercent !== null) {
                // *** USE THE STATE VARIABLE 'distanceThreshold' HERE ***
                if (emaDistancePercent >= distanceThreshold) {
                    alertSignal = 'LONG';
                } else if (emaDistancePercent <= -distanceThreshold) { // Also use it for the negative case
                    alertSignal = 'SHORT';
                }
            }

            let adxSignal: 'LONG' | 'SHORT' | null = null;
            if (plusDI !== null && minusDI !== null) {
                if (plusDI > minusDI) {
                    adxSignal = 'LONG';
                } else if (minusDI > plusDI) {
                    adxSignal = 'SHORT';
                }
            }

            const analysisResult: TickerAnalysisData = {
                symbol,
                bbwPercentage,
                emaShort,
                emaLong,
                emaDistancePercent,
                adx,
                plusDI,
                minusDI,
                adxSignal,
                alertSignal
            };

            return analysisResult;

        } catch (error: any) {
            console.error(`Error processing ticker ${symbol}:`, error);
            return null;
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [distanceThreshold]); // <-- ADD 'distanceThreshold' to the dependency array

    // --- useEffect for performing analysis (no changes needed here, but note dependency) ---
    useEffect(() => {
        if (tickers.length === 0 && tickersLoading) return;

        const performAnalysis = async () => {
            console.log(`Starting analysis for ${tickers.length} tickers with threshold ${distanceThreshold}%...`); // Log threshold used
            setAnalysisLoading(true);
            setAnalysisError(null);
            const newSentAlerts: Record<string, 'LONG' | 'SHORT'> = {};

            try {
                const analysisPromises = tickers.map(ticker => analyzeTicker(ticker));
                const results = await Promise.allSettled(analysisPromises);
                const validResults: TickerAnalysisData[] = [];

                results.forEach(result => {
                    if (result.status === 'fulfilled' && result.value !== null) {
                        validResults.push(result.value);

                        const { symbol, alertSignal, adxSignal } = result.value;
                         if (alertSignal && sentAlerts[symbol] !== alertSignal) {
                             const currentPrice = tickers.find(t => t.symbol === symbol)?.lastPrice ?? 'N/A';
                             const adxSignalText = adxSignal ? ` (Posible: ${adxSignal})` : '';
                             const alertMessage = `🌎 | <b>${symbol}</b>\n💵 | Price: ${currentPrice}\n📈 | Signal: <b>${adxSignalText}</b>`; // Made alert signal bold

                             sendTelegramAlert(alertMessage);
                             newSentAlerts[symbol] = alertSignal;
                         }
                    } else if (result.status === 'rejected') {
                        console.error("Analysis promise rejected:", result.reason);
                    }
                });

                console.log(`Analysis complete. Got valid results for ${validResults.length} tickers.`);
                setAnalysisData(validResults);
                setSentAlerts(prev => ({ ...prev, ...newSentAlerts }));
                setLastAnalysisTime(new Date());

            } catch (e: any) {
                console.error("Error during bulk analysis:", e);
                setAnalysisError(e.message);
                setAnalysisData([]);
            } finally {
                setAnalysisLoading(false);
            }
        };

        // Run analysis if tickers are available OR if analysis data already exists (to re-run with new threshold)
        if (tickers.length > 0 || (!tickersLoading && analysisData.length > 0)) {
             performAnalysis();
        } else if (!tickersLoading && tickers.length === 0) {
            setAnalysisData([]);
            setAnalysisLoading(false);
            setSentAlerts({});
            console.log("No high volatility tickers found, clearing analysis data.");
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tickers, tickersLoading, analyzeTicker, distanceThreshold]); // <-- ADD 'distanceThreshold' dependency here too

    // Function to get analysis data (no change)
    const getAnalysis = (symbol: string) => analysisData.find(d => d.symbol === symbol);

    // Formatting function (no change)
    const formatNum = (num: number | null | undefined, decimals = 2): string => {
         if (num === null || num === undefined || isNaN(num)) {
             return 'N/A';
         }
         const effectiveDecimals = decimals < 5 && Math.abs(num) < 0.01 && num !== 0 ? 5 : decimals;
         return num.toFixed(effectiveDecimals);
    };

    return (
        <div className="container mx-auto p-4">
            <h1 className="text-2xl font-bold mb-2 text-gray-800">
                Binance High Volatility Analysis ({KLINE_INTERVAL} Interval)
            </h1>
             <p className="text-sm text-gray-600 mb-1">
                 Refreshes every {REFRESH_INTERVAL_MS / 1000} seconds. Symbols with > 5% 24hr change.
             </p>
             <p className="text-xs text-gray-500 mb-2">
                 Last analysis: {lastAnalysisTime ? lastAnalysisTime.toLocaleTimeString() : 'N/A'}
             </p>

             {/* --- INPUT FIELD FOR THRESHOLD --- */}
             <div className="mb-4 flex items-center space-x-2">
                 <label htmlFor="distanceThreshold" className="block text-sm font-medium text-gray-700">
                     EMA Distance Alert Threshold (%):
                 </label>
                 <input
                     type="number"
                     id="distanceThreshold"
                     name="distanceThreshold"
                     value={distanceThreshold}
                     onChange={handleThresholdChange}
                     step="0.05" // Smaller step for finer control
                     min="0" // Prevent negative threshold
                     className="p-1 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm w-20" // Added width
                 />
             </div>
             {/* --- END INPUT FIELD --- */}

              {/* --- UPDATED Description to show current threshold --- */}
              <p className="text-xs text-orange-600 mb-4">
                  Alerts trigger when |EMA({EMA_PERIOD_SHORT})/EMA({EMA_PERIOD_LONG}) Dist %| ≥ <strong>{distanceThreshold}%</strong> AND BBW({BBW_PERIOD}) % ≤ {BBW_THRESHOLD}%.
                  ADX Signal based on +DI vs -DI crossover.
                  <strong className="text-red-700"> Ensure Telegram Token/ID are secured!</strong>
              </p>

            {tickersLoading && analysisData.length === 0 ? (
                <div className="text-center py-5 text-gray-600">Loading initial high volatility tickers...</div>
            ) : tickersError ? (
                <div className="text-red-500 text-center py-5">Error loading tickers: {tickersError}</div>
            ) : (
                <div className="overflow-x-auto relative shadow-md rounded-lg">
                     {analysisLoading && (
                         <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center z-10">
                             <div className="text-gray-700 font-semibold">Analyzing {tickers.length} tickers...</div>
                         </div>
                     )}
                    <table className="min-w-full bg-white border border-gray-200">
                        <thead className="bg-gray-100 sticky top-0 z-5">
                            <tr>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">Symbol</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">24h Chg%</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">Last Price</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">BBW%</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">EMA {EMA_PERIOD_SHORT}</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">EMA {EMA_PERIOD_LONG}</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">EMA Dist%</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">ADX({ADX_PERIOD})</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">+DI({ADX_PERIOD})</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">-DI({ADX_PERIOD})</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">ADX Signal</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase tracking-wider">Alert Signal</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {analysisError && (
                                <tr><td colSpan={12} className="px-4 py-3 text-center text-red-500">Error during analysis: {analysisError}</td></tr>
                            )}
                             {!tickersLoading && tickers.length === 0 && !analysisLoading && (
                                 <tr><td colSpan={12} className="px-4 py-3 text-center text-gray-500">No high volatility tickers found. Waiting...</td></tr>
                             )}
                            {analysisData.length > 0 ? analysisData.map((analysis) => {
                                const ticker = tickers.find(t => t.symbol === analysis.symbol);
                                const priceChange = ticker ? parseFloat(ticker.priceChangePercent) : NaN;
                                const priceChangeColor = isNaN(priceChange) ? 'text-gray-800' : priceChange >= 0 ? 'text-green-600' : 'text-red-600';
                                const alertSignalColor = analysis.alertSignal === 'LONG' ? 'text-green-600 font-semibold' : analysis.alertSignal === 'SHORT' ? 'text-red-600 font-semibold' : 'text-gray-500';
                                const adxSignalColor = analysis.adxSignal === 'LONG' ? 'text-green-500' : analysis.adxSignal === 'SHORT' ? 'text-red-500' : 'text-gray-500';
                                const emaDistColor = analysis.emaDistancePercent !== null && analysis.emaDistancePercent >= 0 ? 'text-green-700' : 'text-red-700';

                                // Highlight row if alert condition met
                                const rowHighlightClass = analysis.alertSignal ? 'bg-yellow-100' : 'hover:bg-gray-50';

                                return (
                                    <tr key={analysis.symbol} className={rowHighlightClass}>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-800 font-medium">{analysis.symbol}</td>
                                        <td className={`px-3 py-2 whitespace-nowrap text-sm ${priceChangeColor}`}>{ticker ? `${priceChange.toFixed(2)}%` : 'N/A'}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-800">{ticker ? ticker.lastPrice : 'N/A'}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-800">{formatNum(analysis.bbwPercentage)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-800">{formatNum(analysis.emaShort, 5)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-800">{formatNum(analysis.emaLong, 5)}</td>
                                        <td className={`px-3 py-2 whitespace-nowrap text-sm ${emaDistColor}`}>{formatNum(analysis.emaDistancePercent)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-800">{formatNum(analysis.adx)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-green-600">{formatNum(analysis.plusDI)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-red-600">{formatNum(analysis.minusDI)}</td>
                                        <td className={`px-3 py-2 whitespace-nowrap text-sm ${adxSignalColor}`}>{analysis.adxSignal || '-'}</td>
                                        <td className={`px-3 py-2 whitespace-nowrap text-sm ${alertSignalColor}`}>{analysis.alertSignal || '-'}</td>
                                    </tr>
                                );
                            }) : (
                                !tickersLoading && tickers.length > 0 && !analysisLoading && !analysisError && (
                                     <tr><td colSpan={12} className="px-4 py-3 text-center text-gray-500">No analysis data available (check console).</td></tr>
                                )
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default App;