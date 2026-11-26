import { useEffect, useState } from 'react';

interface CountdownTimerProps {
  targetIso: string;
  className?: string;
}

export function CountdownTimer({ targetIso, className = '' }: CountdownTimerProps) {
  const [remaining, setRemaining] = useState('00:00:00');

  useEffect(() => {
    const update = () => {
      const diffMs = Math.max(0, new Date(targetIso).getTime() - Date.now());
      const totalSec = Math.floor(diffMs / 1000);
      const hrs = Math.floor(totalSec / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      setRemaining(
        `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      );
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  return <span className={`font-mono tabular-nums ${className}`}>{remaining}</span>;
}
