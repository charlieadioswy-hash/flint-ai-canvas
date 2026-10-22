export function ScreenCreationMaskGuide() {
    return (
        <details className="screen-creation-mask-guide">
            <summary>查看透明蒙版与转角示意</summary>
            <figure>
                <div className="screen-creation-transparency-grid">
                    <svg viewBox="0 0 300 190" role="img" aria-label="透明 PNG 蒙版示意：两个不透明屏面相接，中间保留转角线，外围透明" className="screen-creation-mask-example">
                        <title>透明 PNG 转角屏蒙版</title>
                        <desc>棋盘格从透明的 SVG 背景透出，表示屏幕外；两块彩色不透明区域表示屏幕，中间竖线表示转角。</desc>
                        <path d="M34 26 146 58 146 160 34 128Z" className="screen-creation-mask-face" />
                        <path d="M146 58 264 28 264 130 146 160Z" className="screen-creation-mask-face is-side" />
                        <path d="M146 58V160" className="screen-creation-mask-corner" />
                        <text x="88" y="96" className="screen-creation-mask-label">
                            左屏
                        </text>
                        <text x="205" y="96" className="screen-creation-mask-label">
                            右屏
                        </text>
                    </svg>
                </div>
                <figcaption>棋盘格：透明屏外 · 彩色区域：不透明屏内 · 中间竖线：转角</figcaption>
                <p className="screen-creation-hint">彩色不透明区域仍可保留转角线，帮助画面贴合折角。棋盘格仅用于展示透明度，请勿画进蒙版。</p>
            </figure>
        </details>
    );
}
