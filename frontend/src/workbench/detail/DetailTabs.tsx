import React, { useState } from 'react';
import { Box, Tab, Tabs } from '@mui/material';

export interface DetailTabItem {
  label: string;
  content: React.ReactNode;
}

export interface DetailTabsProps {
  tabs: DetailTabItem[];
  /** Uncontrolled by default; only meaningful on first render. */
  initialTab?: number;
}

interface TabPanelProps {
  children: React.ReactNode;
  active: boolean;
  index: number;
}

// Standard MUI tabpanel a11y pattern: `hidden` (not display:none via sx)
// so an inactive panel is genuinely removed from the accessibility tree,
// and content is not even rendered while inactive -- consistent with a
// real tab (as opposed to a "jump to section" nav where everything stays
// mounted).
function TabPanel({ children, active, index }: TabPanelProps): JSX.Element {
  return (
    <div role="tabpanel" hidden={!active} id={`detail-tabpanel-${index}`} aria-labelledby={`detail-tab-${index}`}>
      {active && children}
    </div>
  );
}

// WP-074 -- new kit component (no direct TabContent.tsx precursor: that
// file rendered every section in one long scroll). Named in spec
// sub-project 1 §3.4 as the container that organises a module's detail
// view into "Details/Steps/Links/…" -- generic over what each tab shows,
// so TestPlanDetail/TestRunDetail (WP-076) and DefectDetail (WP-077) reuse
// it unchanged, same as FieldGrid/LinksSection/etc.
export function DetailTabs({ tabs, initialTab = 0 }: DetailTabsProps): JSX.Element {
  const [active, setActive] = useState(initialTab);
  return (
    <Box>
      <Tabs value={active} onChange={(_e, v: number) => setActive(v)} aria-label="Detail sections">
        {tabs.map((t, i) => (
          <Tab key={t.label} label={t.label} id={`detail-tab-${i}`} aria-controls={`detail-tabpanel-${i}`} />
        ))}
      </Tabs>
      {tabs.map((t, i) => (
        <TabPanel key={t.label} active={active === i} index={i}>
          {t.content}
        </TabPanel>
      ))}
    </Box>
  );
}

export default DetailTabs;
