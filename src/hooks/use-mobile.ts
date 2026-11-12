import * as React from "react"

const MOBILE_BREAKPOINT = 768

function compute(): boolean {
  // 宽度为 0 的场景（如嵌入式/预渲染/自动化环境初始化瞬间）不视为移动端
  const width = typeof window === "undefined" ? 1024 : window.innerWidth
  return width > 0 && width < MOBILE_BREAKPOINT
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(compute)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setIsMobile(compute())
    mql.addEventListener("change", onChange)
    // 兜底：部分环境视口就绪时不触发 matchMedia change，只在 resize 时更新
    window.addEventListener("resize", onChange)
    setIsMobile(compute())
    return () => {
      mql.removeEventListener("change", onChange)
      window.removeEventListener("resize", onChange)
    }
  }, [])

  return isMobile
}
