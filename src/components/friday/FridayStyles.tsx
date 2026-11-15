"use client";

import React from "react";

/** Friday 的全局样式仅作用于 .friday-root 子树。 */
export function FridayStyles() {
  return (
    <>
      <style jsx global>{`

        .friday-root{
          position: fixed;
          z-index: 2147483647;
          isolation: isolate;
          right: 16px;
          bottom: max(20px, env(safe-area-inset-bottom, 0px));
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
            "SF Pro Text", "PingFang SC", sans-serif;
          color: #fff;
          pointer-events: none;
        }

        .friday-root button,
        .friday-root textarea,
        .friday-root section{
          pointer-events: auto;
        }

        .friday-root .friday-fab{
          position: fixed;
          right: 16px;
          bottom: max(20px, env(safe-area-inset-bottom, 0px));
          z-index: 2147483647;
          display: grid;
          place-items: center;
          width: 68px;
          height: 68px;
          padding: 0;
          overflow: visible;
          border: 0;
          border-radius: 50%;
          background: transparent;
          cursor: grab;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          -webkit-tap-highlight-color: transparent;
          filter: drop-shadow(0 8px 16px rgba(0,0,0,.24));
        }

        .friday-root .friday-fab:active{ cursor: grabbing; }

        .friday-root .friday-restore{
          position: fixed;
          right: 8px;
          bottom: max(22px,env(safe-area-inset-bottom,0px));
          z-index: 30;
          display: grid;
          place-items: center;
          width: 46px;
          height: 46px;
          padding: 0;
          border: 0;
          border-radius: 50%;
          background: transparent;
          box-shadow: 0 4px 16px rgba(0,0,0,.22);
          cursor: pointer;
          pointer-events: auto;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-root .friday-panel{
          position: fixed;
          right: 14px;
          bottom: calc(96px + env(safe-area-inset-bottom,0px));
          z-index: 30;
          display: flex;
          flex-direction: column;
          width: min(370px,calc(100vw - 28px));
          max-height: min(360px,calc(100dvh - 118px));
          min-height: 150px;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid rgba(255,255,255,.27);
          border-radius: 25px;
          color: #fff;
          background: rgba(12,15,25,.10);
          -webkit-backdrop-filter: blur(2px) saturate(108%);
          backdrop-filter: blur(2px) saturate(108%);
          box-shadow: 0 8px 24px rgba(0,0,0,.16),
            inset 0 1px 0 rgba(255,255,255,.10);
          transform-origin: bottom right;
          animation: friday-capsule-in .42s cubic-bezier(.18,.82,.2,1);
          pointer-events: auto;
        }

        .friday-root .friday-panel[data-liquid-glass-engine="ready"] {
          background: transparent !important;
          border-color: transparent !important;
          box-shadow: none !important;
          -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
        }

        @keyframes friday-capsule-in {
          0% { opacity: 0; transform: translate3d(20px,25px,0) scale(.78); border-radius: 45px; }
          65% { opacity: 1; transform: translate3d(-2px,-2px,0) scale(1.02); }
          100% { transform: translate3d(0,0,0) scale(1); border-radius: 25px; }
        }

        .friday-root .friday-panel.friday-expanded{
          right: 8px;
          bottom: 8px;
          width: min(650px,calc(100vw - 16px));
          height: min(780px,calc(100dvh - 16px));
          max-height: calc(100dvh - 16px);
          min-height: 300px;
          border-radius: 30px;
          animation: friday-expanded-in .35s cubic-bezier(.2,.8,.2,1);
        }

        @keyframes friday-expanded-in {
          from { opacity: .7; transform: translateY(20px) scale(.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .friday-root .friday-panel.friday-closing{
          pointer-events: none;
          animation: friday-panel-close .25s ease-in forwards;
        }

        @keyframes friday-panel-close {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: translate(16px,15px) scale(.94); }
        }

        .friday-root .friday-panel::before{
          position: absolute;
          z-index: -1;
          inset: 0;
          border-radius: inherit;
          background:
            radial-gradient(ellipse at 50% 110%,rgba(115,183,255,.19),transparent 55%),
            radial-gradient(ellipse at 90% 0%,rgba(203,143,255,.13),transparent 45%);
          content: "";
          pointer-events: none;
        }

        .friday-root .friday-canvas-top{
          position: relative;
          z-index: 3;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex: 0 0 auto;
          min-height: 46px;
          padding: 10px 14px 3px 17px;
        }

        .friday-root .friday-wordmark{
          color: rgba(255,255,255,.96);
          font-family: Georgia,"Times New Roman",serif;
          font-size: 20px;
          font-weight: 400;
          letter-spacing: -.8px;
          text-shadow: 0 1px 12px rgba(255,255,255,.15);
        }

        .friday-root .friday-header-actions{
          display: flex;
          align-items: center;
          gap: 9px;
        }

        .friday-root .friday-state-wrap{
          display: flex;
          align-items: center;
          gap: 7px;
          color: rgba(255,255,255,.67);
          font-size: 10px;
        }

        .friday-root .friday-status-dot{
          width: 7px;
          height: 7px;
          flex: 0 0 7px;
          border-radius: 50%;
          background: #8de7dc;
          box-shadow: 0 0 8px rgba(116,239,224,.8);
          animation: friday-dot-pulse 1.8s ease-in-out infinite;
        }

        .friday-root .friday-close-btn{
          display: grid;
          place-items: center;
          width: 29px;
          height: 29px;
          padding: 0;
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 50%;
          background: rgba(255,255,255,.08);
          color: rgba(255,255,255,.88);
          font-size: 19px;
          line-height: 1;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-root .friday-close-btn:active{
          background: rgba(255,255,255,.2);
          transform: scale(.94);
        }

        @keyframes friday-dot-pulse {
          0%,100% { opacity: .6; transform: scale(.85); }
          50% { opacity: 1; transform: scale(1.18); }
        }

        .friday-root .friday-messages{
          position: relative;
          z-index: 1;
          flex: 1 1 auto;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 8px 17px 12px;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,.17) transparent;
        }

        .friday-root .friday-panel:not(.friday-expanded) .friday-messages{
          max-height: 150px;
        }

        .friday-root .friday-welcome{
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-height: 75px;
          padding: 4px 0 10px;
        }

        .friday-root .friday-welcome-kicker{
          margin-bottom: 6px;
          color: rgba(255,255,255,.43);
          font-size: 9px;
          letter-spacing: 2px;
        }

        .friday-root .friday-welcome-title{
          margin: 0 0 5px;
          color: #fff;
          font-size: 19px;
          font-weight: 500;
          letter-spacing: -.6px;
        }

        .friday-root .friday-welcome-text{
          color: rgba(255,255,255,.65);
          font-size: 11px;
          line-height: 1.65;
        }

        .friday-root .friday-message{
          display: flex;
          justify-content: flex-start;
          margin: 0 0 11px;
          animation: friday-message-in .3s ease both;
        }

        .friday-root .friday-message-user{ justify-content: flex-end; }

        @keyframes friday-message-in {
          from { opacity: 0; transform: translateY(7px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .friday-root .friday-message-content{
          max-width: 96%;
          color: rgba(255,255,255,.95);
          font-size: 12px;
          line-height: 1.72;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .friday-root .friday-message-user .friday-message-content{
          max-width: 86%;
          padding: 7px 11px;
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 15px 15px 4px 15px;
          background: rgba(255,255,255,.1);
          color: rgba(255,255,255,.9);
        }

        .friday-root .friday-status{
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 7px 0 12px;
          color: rgba(202,226,255,.88);
          font-size: 11px;
          animation: friday-status-pulse 1.8s ease-in-out infinite;
        }

        .friday-root .friday-status::before{
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #9edfff;
          box-shadow: 0 0 9px #9edfff;
          content: "";
        }

        @keyframes friday-status-pulse {
          0%,100% { opacity: .6; }
          50% { opacity: 1; }
        }

        .friday-root .friday-error{
          margin: 9px 0;
          padding: 10px 12px;
          border: 1px solid rgba(248,113,113,.2);
          border-radius: 14px;
          background: rgba(127,29,29,.18);
          color: #fca5a5;
          font-size: 12px;
          line-height: 1.6;
        }

        .friday-root .friday-orb-stage{
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
          gap: 9px;
          min-height: 38px;
          padding: 0 14px 7px;
          pointer-events: none;
        }

        .friday-root .friday-orb-stage .friday-orb{
          width: 32px;
          height: 32px;
          flex: 0 0 32px;
        }

        .friday-root .friday-orb-status{
          color: rgba(255,255,255,.69);
          font-size: 10px;
          letter-spacing: .3px;
        }

        .friday-root .friday-input-area{
          position: relative;
          z-index: 4;
          flex: 0 0 auto;
          padding: 9px 11px calc(9px + env(safe-area-inset-bottom,0px));
          border-top: 1px solid rgba(255,255,255,.1);
          background: rgba(10,13,22,.27);
          -webkit-backdrop-filter: blur(15px);
          backdrop-filter: blur(15px);
        }

        .friday-root .friday-input-box{
          display: flex;
          align-items: flex-end;
          gap: 7px;
          min-height: 44px;
          padding: 5px 6px 5px 10px;
          border: 1px solid rgba(255,255,255,.24);
          border-radius: 24px;
          background: linear-gradient(145deg,rgba(255,255,255,.15),rgba(255,255,255,.045)),rgba(22,25,35,.48);
          -webkit-backdrop-filter: blur(18px) saturate(160%);
          backdrop-filter: blur(18px) saturate(160%);
          box-shadow: 0 8px 25px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.2);
        }

        .friday-root .friday-plus-btn{
          display: grid;
          place-items: center;
          width: 27px;
          height: 32px;
          flex: 0 0 27px;
          padding: 0;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.8);
          font-size: 22px;
          font-weight: 200;
          cursor: pointer;
        }

        .friday-root .friday-plus-btn:disabled{ opacity: .4; cursor: default; }

        .friday-root .friday-input-divider{
          width: 1px;
          height: 21px;
          flex: 0 0 1px;
          margin: 5px 1px;
          background: rgba(255,255,255,.18);
        }

        .friday-root .friday-textarea{
          flex: 1;
          min-width: 0;
          max-height: 110px;
          resize: none;
          overflow-y: auto;
          border: 0;
          outline: 0;
          background: transparent;
          color: #fff;
          font-family: inherit;
          font-size: 12px;
          line-height: 1.65;
          padding: 5px 0;
        }

        .friday-root .friday-textarea::placeholder{ color: rgba(255,255,255,.53); }
        .friday-root .friday-textarea:disabled{ opacity: .5; }

        .friday-root .friday-send-btn,
        .friday-root .friday-mic-btn{
          display: grid;
          place-items: center;
          width: 33px;
          height: 33px;
          flex: 0 0 33px;
          padding: 0;
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 50%;
          background: rgba(255,255,255,.1);
          color: rgba(255,255,255,.94);
          cursor: pointer;
          font-size: 16px;
          transition: background .2s ease,transform .2s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-root .friday-send-btn{
          border-color: rgba(255,255,255,.8);
          background: #f5f5f5;
          color: #151515;
          font-size: 19px;
        }

        .friday-root .friday-send-btn:disabled,
        .friday-root .friday-mic-btn:disabled{
          opacity: .4;
          cursor: not-allowed;
        }

        .friday-root .friday-mic-btn.active{
          border-color: rgba(130,221,255,.7);
          background: rgba(89,185,255,.23);
          color: #b8eaff;
          animation: friday-dot-pulse 1.4s ease-in-out infinite;
        }

        .friday-root .friday-send-btn:active,
        .friday-root .friday-mic-btn:active{ transform: scale(.91); }

        .friday-root .friday-tools{
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 7px;
          min-height: 21px;
          margin-top: 4px;
          padding: 0 6px;
        }

        .friday-root .friday-tool-group{
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
        }

        .friday-root .friday-tool-btn{
          padding: 4px 2px;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.57);
          cursor: pointer;
          font-family: inherit;
          font-size: 9px;
          white-space: nowrap;
        }

        .friday-root .friday-tool-btn.active{ color: #a9dcff; }
        .friday-root .friday-tool-btn:disabled{ opacity: .35; cursor: not-allowed; }

        .friday-root .friday-voice-error{
          margin: 6px 6px 0;
          color: #ffb4a8;
          font-size: 10px;
          line-height: 1.55;
        }

        .friday-root .friday-movie-section{ margin: 10px 0 15px; }

        .friday-root .friday-result-heading{
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 9px;
          color: rgba(255,255,255,.93);
          font-size: 11px;
          font-weight: 600;
        }

        .friday-root .friday-result-count{
          color: rgba(255,255,255,.55);
          font-weight: 400;
        }

        .friday-root .friday-movie-grid{
          display: grid;
          grid-template-columns: repeat(2,minmax(0,1fr));
          gap: 8px;
        }

        .friday-root .friday-movie-card{
          display: flex;
          min-width: 0;
          gap: 8px;
          padding: 7px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 13px;
          background: rgba(255,255,255,.075);
          color: white;
          text-align: left;
          cursor: pointer;
          transition: background .2s ease,transform .2s ease;
        }

        .friday-root .friday-movie-card:active{
          background: rgba(255,255,255,.15);
          transform: scale(.985);
        }

        .friday-root .friday-poster{
          position: relative;
          width: 46px;
          height: 65px;
          flex: 0 0 46px;
          overflow: hidden;
          border-radius: 7px;
          background: rgba(20,22,27,.8);
        }

        .friday-root .friday-poster img{
          position: absolute;
          z-index: 1;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .friday-root .friday-poster-fallback{
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          color: rgba(255,255,255,.58);
          background: linear-gradient(145deg,#303632,#111512);
        }

        .friday-root .friday-poster-remark{
          position: absolute;
          z-index: 2;
          right: 2px;
          bottom: 2px;
          left: 2px;
          overflow: hidden;
          padding: 2px 3px;
          border-radius: 3px;
          background: rgba(0,0,0,.72);
          color: white;
          font-size: 8px;
          text-align: center;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-root .friday-movie-info{
          min-width: 0;
          flex: 1;
          padding: 2px 0;
        }

        .friday-root .friday-movie-name{
          display: -webkit-box;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          color: rgba(255,255,255,.96);
          font-size: 11px;
          font-weight: 600;
          line-height: 1.5;
        }

        .friday-root .friday-movie-meta,
        .friday-root .friday-movie-source{
          margin-top: 4px;
          overflow: hidden;
          font-size: 9px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-root .friday-movie-meta{ color: rgba(255,255,255,.55); }
        .friday-root .friday-movie-source{ color: rgba(190,221,255,.85); }

        .friday-root .friday-empty-result{
          margin: 10px 0;
          color: rgba(255,255,255,.65);
          font-size: 12px;
        }

        .friday-root .friday-expanded .friday-messages{
          max-height: none;
          padding: 18px 23px;
        }

        .friday-root .friday-expanded .friday-welcome{ min-height: 180px; }
        .friday-root .friday-expanded .friday-welcome-title{ font-size: 32px; }
        .friday-root .friday-expanded .friday-message-content{ font-size: 14px; }
        .friday-root .friday-expanded .friday-orb-stage{ min-height: 55px; }

        .friday-root .friday-expanded .friday-orb-stage .friday-orb{
          width: 48px;
          height: 48px;
          flex-basis: 48px;
        }

        .friday-root .friday-panel.friday-expanded.friday-immersive{
          inset: 0;
          right: 0;
          bottom: 0;
          box-sizing: border-box;
          width: 100vw;
          height: 100dvh;
          max-height: 100dvh;
          min-height: 0;
          padding-top: env(safe-area-inset-top,0px);
          padding-bottom: env(safe-area-inset-bottom,0px);
          border: 0;
          border-radius: 0;
          background:
            radial-gradient(ellipse at 50% 46%,rgba(74,125,210,.2),transparent 38%),
            radial-gradient(ellipse at 50% 68%,rgba(157,91,205,.12),transparent 52%),
            rgba(5,8,18,.98);
          animation: friday-immersive-in .55s cubic-bezier(.18,.82,.2,1);
        }

        @keyframes friday-immersive-in{
          from{ opacity: 0; transform: scale(1.025); }
          to{ opacity: 1; transform: scale(1); }
        }

        .friday-root .friday-immersive .friday-canvas-top{
          min-height: 56px;
          padding: max(14px,env(safe-area-inset-top,0px)) 22px 10px;
        }

        .friday-root .friday-immersive .friday-messages{
          flex: 1 1 0;
          min-height: 0;
          max-height: none;
          padding: clamp(10px,3vh,28px) clamp(18px,6vw,64px);
        }

        .friday-root .friday-immersive .friday-orb-stage{
          flex: 0 0 auto;
          flex-direction: column;
          gap: 18px;
          min-height: clamp(220px,38vh,390px);
          padding: 8px 20px 22px;
        }

        .friday-root .friday-immersive .friday-orb-stage .friday-orb{
          width: clamp(150px,32vw,260px);
          height: clamp(150px,32vw,260px);
          flex: 0 0 auto;
          filter: drop-shadow(0 0 34px rgba(91,151,255,.25));
        }

        .friday-root .friday-immersive .friday-orb-status{
          font-size: 13px;
          letter-spacing: .08em;
          text-align: center;
        }

        .friday-root .friday-immersive .friday-input-area{
          padding: 14px 18px max(14px,env(safe-area-inset-bottom,0px));
          background: rgba(7,10,20,.42);
          border-top-color: rgba(255,255,255,.08);
        }

        .friday-root .friday-immersive .friday-tools{
          flex-wrap: wrap;
        }

        @media (max-width:600px){
          .friday-root .friday-panel.friday-expanded.friday-immersive{
            inset: 0;
            right: 0;
            bottom: 0;
            width: 100vw;
            height: 100dvh;
            max-height: 100dvh;
            border-radius: 0;
          }

          .friday-root .friday-immersive .friday-canvas-top{
            padding-right: 17px;
            padding-left: 17px;
          }

          .friday-root .friday-immersive .friday-orb-stage{
            min-height: clamp(190px,34vh,300px);
            padding-bottom: 12px;
          }

          .friday-root .friday-immersive .friday-orb-stage .friday-orb{
            width: clamp(142px,42vw,210px);
            height: clamp(142px,42vw,210px);
          }

          .friday-root .friday-immersive .friday-input-area{
            padding-right: 10px;
            padding-left: 10px;
          }
        }

        @media (max-height:520px){
          .friday-root .friday-immersive .friday-orb-stage{
            min-height: 150px;
            gap: 8px;
            padding-bottom: 8px;
          }

          .friday-root .friday-immersive .friday-orb-stage .friday-orb{
            width: 112px;
            height: 112px;
          }

          .friday-root .friday-immersive .friday-messages{
            padding-top: 4px;
            padding-bottom: 4px;
          }
        }

        @media (prefers-reduced-motion:reduce){
          .friday-root .friday-panel.friday-expanded.friday-immersive{
            animation: none !important;
          }
        }

        @media (max-width:600px) {
          .friday-root{
            right: 16px;
            bottom: max(20px,env(safe-area-inset-bottom,0px));
          }

          .friday-root .friday-panel{
            right: 8px;
            bottom: calc(92px + env(safe-area-inset-bottom,0px));
            width: calc(100vw - 16px);
            max-height: min(370px,calc(100dvh - 108px));
            border-radius: 24px;
          }

          .friday-root .friday-panel.friday-expanded{
            right: 4px;
            bottom: 0;
            width: calc(100vw - 8px);
            height: 100dvh;
            max-height: 100dvh;
            border-radius: 25px 25px 0 0;
          }

          .friday-root .friday-canvas-top{
            padding: max(10px,env(safe-area-inset-top,0px)) 13px 3px;
          }

          .friday-root .friday-messages{
            padding-right: 14px;
            padding-left: 14px;
          }

          .friday-root .friday-expanded .friday-messages{ padding: 16px; }

          .friday-root .friday-input-area{
            padding-right: 9px;
            padding-left: 9px;
          }

          .friday-root .friday-movie-grid{ gap: 7px; }

          .friday-root .friday-movie-card{
            gap: 6px;
            padding: 6px;
          }

          .friday-root .friday-poster{
            width: 42px;
            height: 61px;
            flex-basis: 42px;
          }
        }

        @media (max-height:520px) {
          .friday-root .friday-panel.friday-expanded{
            bottom: 4px;
            height: calc(100dvh - 8px);
            min-height: 0;
            border-radius: 20px;
          }

          .friday-root .friday-canvas-top{
            min-height: 38px;
            padding-top: 7px;
          }

          .friday-root .friday-expanded .friday-welcome{ min-height: 100px; }
          .friday-root .friday-orb-stage{ min-height: 32px; }
          .friday-root .friday-input-area{ padding-top: 5px; }
          .friday-root .friday-tools{ margin-top: 2px; }
        }

        @media (prefers-reduced-motion:reduce) {
          .friday-root .friday-fab *,
        .friday-root .friday-panel,
        .friday-root .friday-orb,
        .friday-root ,
        .friday-root ,
        .friday-root .friday-status-dot,
        .friday-root .friday-message,
        .friday-root .friday-status{
            animation: none !important;
          }

          .friday-root .friday-fab,
        .friday-root .friday-send-btn,
        .friday-root .friday-mic-btn,
        .friday-root .friday-movie-card{
            transition: none !important;
          }
        }

        @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
          .friday-root .friday-panel{ background: rgba(12,15,25,.97); }
          .friday-root .friday-input-box,
        .friday-root .friday-movie-card{ background: rgba(35,37,44,.96); }
        }
      

        .friday-root .friday-sigil-canvas{
          display:block;
          width:100%;
          height:100%;
        }

      `}</style>
    </>
  );
}
