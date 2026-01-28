import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Repeat, Wrench } from 'lucide-react';

export default function Swap() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-p01-border">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 hover:bg-p01-surface rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-p01-chrome" />
          </button>
          <h1 className="text-lg font-semibold text-white">Swap</h1>
        </div>
      </div>

      {/* Coming Soon Content */}
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col items-center text-center"
        >
          {/* Icon */}
          <div className="w-20 h-20 rounded-full bg-p01-surface flex items-center justify-center mb-6">
            <Repeat className="w-10 h-10 text-p01-cyan" />
          </div>

          {/* Title */}
          <h2 className="text-2xl font-display font-bold text-white mb-3">
            Coming Soon
          </h2>

          {/* Description */}
          <p className="text-p01-chrome text-sm max-w-[280px] mb-6">
            Token swap is currently under development. This feature will be available in the next update.
          </p>

          {/* Status Badge */}
          <div className="flex items-center gap-2 px-4 py-2 bg-p01-surface rounded-full">
            <Wrench className="w-4 h-4 text-p01-pink" />
            <span className="text-sm text-p01-chrome">In Development</span>
          </div>
        </motion.div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="w-full py-3.5 bg-p01-surface text-white font-semibold rounded-xl hover:bg-p01-elevated transition-colors"
        >
          Go Back
        </button>
      </div>
    </div>
  );
}
