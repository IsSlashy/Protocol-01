/**
 * Stream Analyzer Service for P-01 Agent
 *
 * Analyzes user's streams/subscriptions to provide smart recommendations
 * for saving money and optimizing recurring payments.
 */

import { Stream } from '../solana/streams';

// Analysis result types
export interface StreamAnalysis {
  totalMonthlySpend: number;
  totalYearlySpend: number;
  activeStreams: number;
  pausedStreams: number;
  cancelledStreams: number;
  recommendations: StreamRecommendation[];
  savingsPotential: number;
  balanceRunwayDays: number | null;
  upcomingPayments: UpcomingPayment[];
}

export interface StreamRecommendation {
  type: 'cancel' | 'pause' | 'review' | 'alert';
  priority: 'high' | 'medium' | 'low';
  streamId: string;
  streamName: string;
  reason: string;
  potentialSavings: number;
  actionText: string;
}

export interface UpcomingPayment {
  streamId: string;
  streamName: string;
  amount: number;
  dueDate: Date;
  daysUntil: number;
}

// Interval to days mapping
const INTERVAL_DAYS: Record<string, number> = {
  daily: 1,
  d: 1,
  weekly: 7,
  w: 7,
  biweekly: 14,
  monthly: 30,
  m: 30,
  quarterly: 90,
  q: 90,
  yearly: 365,
  y: 365,
};

/**
 * Analyze streams and generate recommendations
 */
export function analyzeStreams(
  streams: Stream[],
  currentBalance: number
): StreamAnalysis {
  const now = Date.now();
  const activeStreams = streams.filter(s => s.status === 'active');
  const pausedStreams = streams.filter(s => s.status === 'paused');
  const cancelledStreams = streams.filter(s => s.status === 'cancelled');

  // Calculate spending
  let totalMonthlySpend = 0;
  activeStreams.forEach(stream => {
    totalMonthlySpend += calculateMonthlyAmount(stream.amountPerPayment, stream.frequency);
  });

  const totalYearlySpend = totalMonthlySpend * 12;

  // Generate recommendations
  const recommendations: StreamRecommendation[] = [];
  let savingsPotential = 0;

  activeStreams.forEach(stream => {
    const monthlyAmount = calculateMonthlyAmount(stream.amountPerPayment, stream.frequency);
    const daysSinceCreated = Math.floor((now - stream.startDate) / (1000 * 60 * 60 * 24));
    // Calculate last payment from paymentsCompleted and frequency
    const intervalDays = INTERVAL_DAYS[stream.frequency] || 30;
    const lastPaymentEstimate = stream.paymentsCompleted > 0
      ? stream.startDate + (stream.paymentsCompleted * intervalDays * 24 * 60 * 60 * 1000)
      : stream.startDate;
    const daysSinceLastPayment = Math.floor((now - lastPaymentEstimate) / (1000 * 60 * 60 * 24));

    // Check for unused streams (no payment in 60+ days for monthly)
    if (daysSinceLastPayment > intervalDays * 2) {
      recommendations.push({
        type: 'cancel',
        priority: 'high',
        streamId: stream.id,
        streamName: stream.name,
        reason: `No payment in ${daysSinceLastPayment} days`,
        potentialSavings: monthlyAmount,
        actionText: `Cancel to save ${monthlyAmount.toFixed(4)} SOL/month`,
      });
      savingsPotential += monthlyAmount;
    }

    // Check for high-cost streams (>20% of total spending)
    if (monthlyAmount > totalMonthlySpend * 0.2 && totalMonthlySpend > 0) {
      const percentage = Math.round((monthlyAmount / totalMonthlySpend) * 100);
      recommendations.push({
        type: 'review',
        priority: 'medium',
        streamId: stream.id,
        streamName: stream.name,
        reason: `Represents ${percentage}% of your monthly spending`,
        potentialSavings: monthlyAmount * 0.5, // Assume 50% could be saved
        actionText: `Review if needed (${monthlyAmount.toFixed(4)} SOL/month)`,
      });
    }

    // Check for streams with max payments reached
    if (stream.totalPayments && stream.paymentsCompleted >= stream.totalPayments) {
      recommendations.push({
        type: 'cancel',
        priority: 'low',
        streamId: stream.id,
        streamName: stream.name,
        reason: `Max payments reached (${stream.paymentsCompleted}/${stream.totalPayments})`,
        potentialSavings: 0,
        actionText: 'Remove this completed stream',
      });
    }
  });

  // Calculate balance runway
  let balanceRunwayDays: number | null = null;
  if (totalMonthlySpend > 0 && currentBalance > 0) {
    const dailySpend = totalMonthlySpend / 30;
    balanceRunwayDays = Math.floor(currentBalance / dailySpend);

    // Alert if balance will run out soon
    if (balanceRunwayDays < 7) {
      recommendations.push({
        type: 'alert',
        priority: 'high',
        streamId: '',
        streamName: 'Low balance',
        reason: `Your balance will be depleted in ~${balanceRunwayDays} days`,
        potentialSavings: 0,
        actionText: 'Top up your wallet or reduce your streams',
      });
    } else if (balanceRunwayDays < 30) {
      recommendations.push({
        type: 'alert',
        priority: 'medium',
        streamId: '',
        streamName: 'Balance forecast',
        reason: `Balance sufficient for ~${balanceRunwayDays} days`,
        potentialSavings: 0,
        actionText: 'Consider topping up soon',
      });
    }
  }

  // Calculate upcoming payments
  const upcomingPayments: UpcomingPayment[] = activeStreams
    .map(stream => {
      const nextPaymentDate = new Date(stream.nextPaymentDate);
      const daysUntil = Math.ceil((stream.nextPaymentDate - now) / (1000 * 60 * 60 * 24));
      return {
        streamId: stream.id,
        streamName: stream.name,
        amount: stream.amountPerPayment,
        dueDate: nextPaymentDate,
        daysUntil: Math.max(0, daysUntil),
      };
    })
    .filter(p => p.daysUntil <= 30) // Only next 30 days
    .sort((a, b) => a.daysUntil - b.daysUntil);

  // Sort recommendations by priority
  recommendations.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });

  return {
    totalMonthlySpend,
    totalYearlySpend,
    activeStreams: activeStreams.length,
    pausedStreams: pausedStreams.length,
    cancelledStreams: cancelledStreams.length,
    recommendations,
    savingsPotential,
    balanceRunwayDays,
    upcomingPayments,
  };
}

/**
 * Calculate monthly equivalent amount
 */
function calculateMonthlyAmount(amount: number, interval: string): number {
  const days = INTERVAL_DAYS[interval] || 30;
  return (amount * 30) / days;
}

/**
 * Format analysis as AI-friendly text
 */
export function formatAnalysisForAI(analysis: StreamAnalysis): string {
  let message = 'SUBSCRIPTION ANALYSIS\n\n';

  // Summary
  message += `SUMMARY:\n`;
  message += `- ${analysis.activeStreams} active streams\n`;
  message += `- Monthly spend: ${analysis.totalMonthlySpend.toFixed(4)} SOL\n`;
  message += `- Yearly spend: ${analysis.totalYearlySpend.toFixed(4)} SOL\n`;

  if (analysis.balanceRunwayDays !== null) {
    message += `- Balance runway: ~${analysis.balanceRunwayDays} days\n`;
  }

  // Recommendations
  if (analysis.recommendations.length > 0) {
    message += `\nRECOMMENDATIONS (${analysis.recommendations.length}):\n`;

    const highPriority = analysis.recommendations.filter(r => r.priority === 'high');
    const mediumPriority = analysis.recommendations.filter(r => r.priority === 'medium');

    if (highPriority.length > 0) {
      message += `\n[URGENT]\n`;
      highPriority.slice(0, 3).forEach(rec => {
        message += `- ${rec.streamName}: ${rec.reason}\n`;
        message += `  > ${rec.actionText}\n`;
      });
    }

    if (mediumPriority.length > 0) {
      message += `\n[TO REVIEW]\n`;
      mediumPriority.slice(0, 2).forEach(rec => {
        message += `- ${rec.streamName}: ${rec.reason}\n`;
      });
    }

    if (analysis.savingsPotential > 0) {
      message += `\nPOTENTIAL SAVINGS: ${analysis.savingsPotential.toFixed(4)} SOL/month`;
      message += ` (${(analysis.savingsPotential * 12).toFixed(4)} SOL/year)\n`;
    }
  } else {
    message += `\nEverything looks optimized! No recommendations at this time.\n`;
  }

  // Upcoming payments
  if (analysis.upcomingPayments.length > 0) {
    message += `\nUPCOMING PAYMENTS:\n`;
    analysis.upcomingPayments.slice(0, 5).forEach(payment => {
      const dayText = payment.daysUntil === 0 ? 'Today' :
                      payment.daysUntil === 1 ? 'Tomorrow' :
                      `In ${payment.daysUntil} days`;
      message += `- ${payment.streamName}: ${payment.amount} SOL (${dayText})\n`;
    });
  }

  return message;
}

/**
 * Get quick summary for balance check
 */
export function getBalanceSummary(
  balance: number,
  analysis: StreamAnalysis
): string {
  let message = `YOUR BALANCE: ${balance.toFixed(4)} SOL\n\n`;

  if (analysis.activeStreams === 0) {
    message += 'No active streams.\n';
    return message;
  }

  message += `RECURRING EXPENSES:\n`;
  message += `- ${analysis.activeStreams} active streams\n`;
  message += `- ${analysis.totalMonthlySpend.toFixed(4)} SOL/month\n`;

  if (analysis.balanceRunwayDays !== null) {
    if (analysis.balanceRunwayDays < 7) {
      message += `\n[WARNING] Balance depleted in ~${analysis.balanceRunwayDays} days!\n`;
      message += `Top up or reduce your streams.\n`;
    } else if (analysis.balanceRunwayDays < 30) {
      message += `\nRunway: ~${analysis.balanceRunwayDays} days\n`;
    } else {
      message += `\nRunway: ~${analysis.balanceRunwayDays} days (OK)\n`;
    }
  }

  if (analysis.savingsPotential > 0) {
    message += `\nPossible savings: ${analysis.savingsPotential.toFixed(4)} SOL/month\n`;
    message += `Ask "analyze my subscriptions" for more details.`;
  }

  return message;
}
