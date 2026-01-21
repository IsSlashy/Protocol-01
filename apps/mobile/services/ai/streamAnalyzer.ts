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
    totalMonthlySpend += calculateMonthlyAmount(stream.amount, stream.interval);
  });

  const totalYearlySpend = totalMonthlySpend * 12;

  // Generate recommendations
  const recommendations: StreamRecommendation[] = [];
  let savingsPotential = 0;

  activeStreams.forEach(stream => {
    const monthlyAmount = calculateMonthlyAmount(stream.amount, stream.interval);
    const daysSinceCreated = Math.floor((now - stream.createdAt) / (1000 * 60 * 60 * 24));
    const daysSinceLastPayment = stream.lastPayment
      ? Math.floor((now - stream.lastPayment) / (1000 * 60 * 60 * 24))
      : daysSinceCreated;

    // Check for unused streams (no payment in 60+ days for monthly)
    const intervalDays = INTERVAL_DAYS[stream.interval] || 30;
    if (daysSinceLastPayment > intervalDays * 2) {
      recommendations.push({
        type: 'cancel',
        priority: 'high',
        streamId: stream.id,
        streamName: stream.name,
        reason: `Aucun paiement depuis ${daysSinceLastPayment} jours`,
        potentialSavings: monthlyAmount,
        actionText: `Annuler pour économiser ${monthlyAmount.toFixed(4)} SOL/mois`,
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
        reason: `Représente ${percentage}% de vos dépenses mensuelles`,
        potentialSavings: monthlyAmount * 0.5, // Assume 50% could be saved
        actionText: `Vérifier si nécessaire (${monthlyAmount.toFixed(4)} SOL/mois)`,
      });
    }

    // Check for streams with max payments reached
    if (stream.maxPayments && stream.paymentsMade >= stream.maxPayments) {
      recommendations.push({
        type: 'cancel',
        priority: 'low',
        streamId: stream.id,
        streamName: stream.name,
        reason: `Nombre max de paiements atteint (${stream.paymentsMade}/${stream.maxPayments})`,
        potentialSavings: 0,
        actionText: 'Supprimer ce stream terminé',
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
        streamName: 'Solde bas',
        reason: `Votre solde sera épuisé dans ~${balanceRunwayDays} jours`,
        potentialSavings: 0,
        actionText: 'Rechargez votre wallet ou réduisez vos streams',
      });
    } else if (balanceRunwayDays < 30) {
      recommendations.push({
        type: 'alert',
        priority: 'medium',
        streamId: '',
        streamName: 'Prévision solde',
        reason: `Solde suffisant pour ~${balanceRunwayDays} jours`,
        potentialSavings: 0,
        actionText: 'Pensez à recharger bientôt',
      });
    }
  }

  // Calculate upcoming payments
  const upcomingPayments: UpcomingPayment[] = activeStreams
    .map(stream => {
      const nextPaymentDate = new Date(stream.nextPayment);
      const daysUntil = Math.ceil((stream.nextPayment - now) / (1000 * 60 * 60 * 24));
      return {
        streamId: stream.id,
        streamName: stream.name,
        amount: stream.amount,
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
  let message = 'ANALYSE DE VOS ABONNEMENTS\n\n';

  // Summary
  message += `RÉSUMÉ:\n`;
  message += `- ${analysis.activeStreams} streams actifs\n`;
  message += `- Dépense mensuelle: ${analysis.totalMonthlySpend.toFixed(4)} SOL\n`;
  message += `- Dépense annuelle: ${analysis.totalYearlySpend.toFixed(4)} SOL\n`;

  if (analysis.balanceRunwayDays !== null) {
    message += `- Autonomie solde: ~${analysis.balanceRunwayDays} jours\n`;
  }

  // Recommendations
  if (analysis.recommendations.length > 0) {
    message += `\nRECOMMANDATIONS (${analysis.recommendations.length}):\n`;

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
      message += `\n[À VÉRIFIER]\n`;
      mediumPriority.slice(0, 2).forEach(rec => {
        message += `- ${rec.streamName}: ${rec.reason}\n`;
      });
    }

    if (analysis.savingsPotential > 0) {
      message += `\nÉCONOMIES POTENTIELLES: ${analysis.savingsPotential.toFixed(4)} SOL/mois`;
      message += ` (${(analysis.savingsPotential * 12).toFixed(4)} SOL/an)\n`;
    }
  } else {
    message += `\nTout semble optimisé! Aucune recommandation pour le moment.\n`;
  }

  // Upcoming payments
  if (analysis.upcomingPayments.length > 0) {
    message += `\nPROCHAINS PAIEMENTS:\n`;
    analysis.upcomingPayments.slice(0, 5).forEach(payment => {
      const dayText = payment.daysUntil === 0 ? 'Aujourd\'hui' :
                      payment.daysUntil === 1 ? 'Demain' :
                      `Dans ${payment.daysUntil} jours`;
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
  let message = `VOTRE SOLDE: ${balance.toFixed(4)} SOL\n\n`;

  if (analysis.activeStreams === 0) {
    message += 'Aucun stream actif.\n';
    return message;
  }

  message += `DÉPENSES RÉCURRENTES:\n`;
  message += `- ${analysis.activeStreams} streams actifs\n`;
  message += `- ${analysis.totalMonthlySpend.toFixed(4)} SOL/mois\n`;

  if (analysis.balanceRunwayDays !== null) {
    if (analysis.balanceRunwayDays < 7) {
      message += `\n[ATTENTION] Solde épuisé dans ~${analysis.balanceRunwayDays} jours!\n`;
      message += `Rechargez ou réduisez vos streams.\n`;
    } else if (analysis.balanceRunwayDays < 30) {
      message += `\nAutonomie: ~${analysis.balanceRunwayDays} jours\n`;
    } else {
      message += `\nAutonomie: ~${analysis.balanceRunwayDays} jours (OK)\n`;
    }
  }

  if (analysis.savingsPotential > 0) {
    message += `\nÉconomies possibles: ${analysis.savingsPotential.toFixed(4)} SOL/mois\n`;
    message += `Demandez "analyser mes abonnements" pour plus de détails.`;
  }

  return message;
}
