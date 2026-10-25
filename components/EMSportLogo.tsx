import React from 'react';
import { motion } from 'motion/react';

export type LogoVariant = 'badge' | 'monogram' | 'horizontal' | 'hero' | 'loading' | 'watermark';
export type LogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';

interface EMSportLogoProps {
  variant?: LogoVariant;
  size?: LogoSize;
  className?: string;
  animated?: boolean;
  showTagline?: boolean;
}

export const EMSportLogo: React.FC<EMSportLogoProps> = ({
  variant = 'badge',
  size = 'md',
  className = '',
  animated = false,
  showTagline = false,
}) => {
  const sizeMap: Record<LogoSize, string> = {
    xs: 'w-7 h-7',
    sm: 'w-9 h-9',
    md: 'w-12 h-12',
    lg: 'w-14 h-14',
    xl: 'w-20 h-20',
    '2xl': 'w-28 h-28',
    '3xl': 'w-36 h-36',
  };

  const dimensionClass = sizeMap[size] || sizeMap.md;

  if (variant === 'loading') {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 ${className}`}>
        <div className="relative w-20 h-20 flex items-center justify-center">
          <motion.div 
            animate={{ scale: [1, 1.04, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            className="w-full h-full"
          >
            <img src="/logo.svg" alt="EM Sports Logo" className="w-full h-full object-contain drop-shadow-sm" />
          </motion.div>
        </div>
        <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">
          AI Visualization in Progress...
        </span>
      </div>
    );
  }

  if (variant === 'hero') {
    return (
      <div className={`relative inline-flex items-center justify-center ${className}`}>
        <div className={`${dimensionClass} relative z-10 drop-shadow-md transition-transform duration-300 hover:scale-105`}>
          <img src="/logo.svg" alt="EM Sports Logo" className="w-full h-full object-contain" />
        </div>
      </div>
    );
  }

  if (variant === 'watermark') {
    return (
      <div className={`opacity-85 flex items-center gap-2 bg-white/95 backdrop-blur-sm px-3 py-1 rounded-full shadow-sm border border-gray-100 ${className}`}>
        <div className="w-5 h-5 shrink-0">
          <img src="/logo.svg" alt="EM Sports Logo" className="w-full h-full object-contain" />
        </div>
        <span className="text-xs font-semibold tracking-tight text-gray-800">
          EM SPORTS
        </span>
      </div>
    );
  }

  if (variant === 'horizontal') {
    return (
      <div className={`inline-flex items-center gap-3 select-none ${className}`}>
        <div className={`${dimensionClass} shrink-0 transition-transform duration-300 hover:scale-105`}>
          <img src="/logo.svg" alt="EM Sports Logo" className="w-full h-full object-contain drop-shadow-sm" />
        </div>
        <div className="flex flex-col justify-center">
          <span className="font-bold text-lg sm:text-xl tracking-tight text-gray-900 leading-none">
            EM SPORTS
          </span>
          {showTagline && (
            <span className="text-[10px] font-medium tracking-wider text-gray-500 uppercase mt-1">
              AI Try-On Studio
            </span>
          )}
        </div>
      </div>
    );
  }

  // Default & monogram: standalone circular badge using the exact logo.svg file
  return (
    <div className={`inline-block select-none ${dimensionClass} ${className} transition-transform duration-300 hover:scale-105`}>
      <img src="/logo.svg" alt="EM Sports Logo" className="w-full h-full object-contain drop-shadow-sm" />
    </div>
  );
};
