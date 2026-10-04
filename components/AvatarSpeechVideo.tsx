import React, { useEffect, useRef } from 'react';

export function AvatarSpeechVideo({ src, idleSrc, poster, speaking, className, onError }: {
  src: string;
  idleSrc?: string;
  poster: string;
  speaking: boolean;
  className: string;
  onError: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const activeSrc = !speaking && idleSrc ? idleSrc : src;

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    const update = () => {
      if (speaking || idleSrc) {
        void video.play().catch(error => {
          if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
          console.error('Nexus avatar playback failed:', error);
          errorRef.current();
        });
      } else {
        video.pause();
        if (video.readyState > 0) video.currentTime = 0;
      }
    };
    video.addEventListener('loadeddata', update);
    update();
    return () => {
      active = false;
      video.removeEventListener('loadeddata', update);
      video.pause();
    };
  }, [activeSrc, speaking, idleSrc]);

  return <video ref={ref} loop muted playsInline preload="auto" className={className} src={activeSrc} poster={poster}
    aria-label={speaking ? 'Luna — animacja podczas mowy' : idleSrc ? 'Luna — spokojne mruganie w ciszy' : 'Luna — androidka; animacja tylko podczas mowy'} onError={onError}/>;
}
