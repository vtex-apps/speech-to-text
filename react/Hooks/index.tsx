import {useState, useEffect, useRef} from 'react';
import Hark from 'hark';
// @ts-ignore
import {startRecording, stopRecording} from "./recorderHelpers.js";

// https://cloud.google.com/speech-to-text/docs/reference/rest/v1/RecognitionConfig
import {GoogleCloudRecognitionConfig} from './GoogleCloudRecognitionConfig';
import {UseSpeechToTextTypes} from '../@types/stt';
import {is_constructor} from "../utils";

// const isEdgeChromium = navigator?.userAgent?.indexOf('Edg/') !== -1 || false;

const AudioContext = window.AudioContext || (window as any).webkitAudioContext;

const SpeechRecognition =
  window.SpeechRecognition || (window as any).webkitSpeechRecognition;

let recognition: SpeechRecognition | null;

// Set recognition back to null for brave browser due to promise resolving
// after the conditional on line 31
// Brave unsupported for know
// if (navigator) {
//   if ((navigator as BraveNavigator).brave) {
//     (navigator as BraveNavigator).brave.isBrave().then((bool: boolean) => {
//       if (bool) recognition = null;
//     });
//   }
// }

// Chromium browsers will have the SpeechRecognition method
// but do not implement the functionality due to google wanting 💰
// this covers new Edge and line 22 covers Brave, the two most popular non-chrome chromium browsers
if (is_constructor(SpeechRecognition)) {
  recognition = new SpeechRecognition();
}


export default function useSpeechToText({
                                          continuous,
                                          crossBrowser,
                                          googleApiKey,
                                          googleCloudRecognitionConfig,
                                          onStartSpeaking,
                                          onStoppedSpeaking,
                                          speechRecognitionProperties,
                                          timeout,
                                          useOnlyGoogleCloud = false
                                        }: UseSpeechToTextTypes) {
  const [isRecording, setIsRecording] = useState(false);

  const audioContextRef = useRef<AudioContext>();

  const [results, setResults] = useState<string[]>([]);
  const [interimResult, setInterimResult] = useState<string | undefined>();
  const [error, setError] = useState('');

  const timeoutId = useRef<number>();
  const mediaStream = useRef<MediaStream>();

  useEffect(() => {
    if (!crossBrowser && !recognition) {
      setError('Speech Recognition API is only available on Chrome');
    }

    if (!navigator?.mediaDevices?.getUserMedia) {
      setError('getUserMedia is not supported on this device/browser :(');
    }

    if ((crossBrowser || useOnlyGoogleCloud) && !googleApiKey) {
      console.error(
        'No google cloud API key was passed, google API will not be able to process speech'
      );
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
  }, []);

  // Chrome Speech Recognition API:
  // Only supported on Chrome browsers
  const chromeSpeechRecognition = () => {
    if (recognition) {
      // Continuous recording after stopped speaking event
      if (continuous) recognition.continuous = true;

      const {grammars, interimResults, lang, maxAlternatives} =
      speechRecognitionProperties || {};

      if (grammars) recognition.grammars = grammars;
      if (lang) recognition.lang = lang;

      recognition.interimResults = interimResults || false;
      recognition.maxAlternatives = maxAlternatives || 1;

      // start recognition
      recognition.start();

      // speech successfully translated into text
      recognition.onresult = (e) => {
        const result = e.results[e.results.length - 1];
        const {transcript} = result[0];

        // Allows for realtime speech result UI feedback
        if (interimResults) {
          if (result.isFinal) {
            setInterimResult(undefined);
            setResults((prevResults) => [...prevResults, transcript]);
          } else {
            let concatTranscripts = '';

            // If continuous: e.results will include previous speech results: need to start loop at the current event resultIndex for proper concatenation
            for (let i = e.resultIndex; i < e.results.length; i++) {
              concatTranscripts += e.results[i][0].transcript;
            }

            setInterimResult(concatTranscripts);
          }
        } else {
          setResults((prevResults) => [...prevResults, transcript]);
        }
      };

      recognition.onaudiostart = () => setIsRecording(true);

      // Audio stopped recording or timed out.
      // Chrome speech auto times-out if no speech after a while
      recognition.onend = () => {
        setIsRecording(false);
      };
    }
  };

  const startSpeechToText = async () => {
    if (!useOnlyGoogleCloud && recognition) {
      chromeSpeechRecognition();
      return;
    }

    if (!crossBrowser && !useOnlyGoogleCloud) {
      return;
    }

    // Resume audio context due to google auto play policy
    // https://developers.google.com/web/updates/2017/09/autoplay-policy-changes#webaudio
    if (audioContextRef.current?.state === 'suspended') {
      audioContextRef.current?.resume();
    }

    const stream = await startRecording({
      errHandler: () => setError('Microphone permission was denied'),
      audioContext: audioContextRef.current as AudioContext
    });

    // Stop recording if timeout
    if (timeout) {
      handleRecordingTimeout();
    }

    // stop previous mediaStream track if exists
    if (mediaStream.current) {
      mediaStream.current.getAudioTracks()[0].stop();
    }

    // Clones stream to fix hark bug on Safari
    mediaStream.current = stream.clone();

    const speechEvents = Hark(mediaStream.current, {
      audioContext: audioContextRef.current as AudioContext
    });

    speechEvents.on('speaking', () => {
      if (onStartSpeaking) onStartSpeaking();

      // Clear previous recording timeout on every speech event
      clearTimeout(timeoutId.current);
    });

    speechEvents.on('stopped_speaking', () => {
      if (onStoppedSpeaking) onStoppedSpeaking();

      setIsRecording(false);
      mediaStream.current?.getAudioTracks()[0].stop();

      // Stops current recording and sends audio string to google cloud.
      // recording will start again after google cloud api
      // call if `continuous` prop is true. Until the api result
      // returns, technically the microphone is not being captured again
      stopRecording({
        exportWAV: true,
        wavCallback: (blob: any) =>
          handleBlobToBase64({blob, continuous: continuous || false})
      });
    });

    setIsRecording(true);
  };

  const stopSpeechToText = () => {
    if (recognition && !useOnlyGoogleCloud) {
      recognition.stop();
    } else {
      setIsRecording(false);
      mediaStream.current?.getAudioTracks()[0].stop();
      stopRecording({
        exportWAV: true,
        wavCallback: (blob: any) => handleBlobToBase64({blob, continuous: false})
      });
    }
  };

  const handleRecordingTimeout = () => {
    timeoutId.current = window.setTimeout(() => {
      setIsRecording(false);
      mediaStream.current?.getAudioTracks()[0].stop();
      stopRecording({exportWAV: false});
    }, timeout);
  };

  const handleBlobToBase64 = ({
                                blob,
                                continuous
                              }: {
    blob: Blob;
    continuous: boolean;
  }) => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);

    reader.onloadend = async () => {
      const base64data = reader.result as string;

      let sampleRate = audioContextRef.current?.sampleRate;

      // Google only accepts max 48000 sample rate: if
      // greater recorder js will down-sample to 48000
      if (sampleRate && sampleRate > 48000) {
        sampleRate = 48000;
      }

      const audio = {content: ''};

      const config: GoogleCloudRecognitionConfig = {
        encoding: 'LINEAR16',
        languageCode: 'en-US',
        sampleRateHertz: sampleRate,
        ...googleCloudRecognitionConfig
      };

      const data = {
        config,
        audio
      };

      // Gets raw base 64 string data
      audio.content = base64data.substr(base64data.indexOf(',') + 1);

      const googleCloudRes = await fetch(
        `https://speech.googleapis.com/v1/speech:recognize?key=${googleApiKey}`,
        {
          method: 'POST',
          body: JSON.stringify(data)
        }
      );

      const googleCloudJson = await googleCloudRes.json();

      // Update results state with transcribed text
      if (googleCloudJson.results?.length > 0) {
        setResults((prevResults) => [
          ...prevResults,
          googleCloudJson.results[0].alternatives[0].transcript
        ]);
      }

      if (continuous) {
        startSpeechToText();
      }
    };
  };

  return {
    error,
    interimResult,
    isRecording,
    results,
    startSpeechToText,
    stopSpeechToText
  };
}
