import React, { useEffect, useRef } from 'react';

export function AvatarSpeechVideo({ src, poster, speaking, className, onError }: {
  src: string;
  poster: string;
  speaking: boolean;
  className: string;
  onError: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    const update = () => {
      if (speaking) {
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
  }, [src, speaking]);

  return <video ref={ref} loop muted playsInline preload="auto" className={className} src={src} poster={poster}
    aria-label="Luna — androidka; animacja tylko podczas mowy" onError={onError}/>;
}
