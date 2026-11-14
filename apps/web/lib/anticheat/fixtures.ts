/**
 * Real C++ / Python / Java programs used by the anti-cheat tests and the benchmark.
 *
 * Problem: "read n and n integers, print the length of the longest strictly increasing subsequence".
 *   - `dp`      : the classic O(n^2) dynamic programme
 *   - `dpTwin`  : the SAME logic with every variable/function renamed, different layout, comments, `std::` qualifiers
 *   - `search`  : a different algorithm (O(n log n) patience sorting with binary search)
 */

import type { AntiCheatLanguage } from './types';

interface Variants {
  dp: string;
  dpTwin: string;
  search: string;
}

export const LIS: Record<AntiCheatLanguage, Variants> = {
  cpp: {
    dp: `#include <bits/stdc++.h>
using namespace std;

int main() {
    int n;
    cin >> n;
    vector<int> a(n);
    for (int i = 0; i < n; i++) {
        cin >> a[i];
    }
    vector<int> dp(n, 1);
    int best = 0;
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < i; j++) {
            if (a[j] < a[i] && dp[j] + 1 > dp[i]) {
                dp[i] = dp[j] + 1;
            }
        }
        best = max(best, dp[i]);
    }
    cout << best << endl;
    return 0;
}
`,
    dpTwin: `// longest increasing subsequence, quadratic
#include <iostream>
#include <vector>
#include <algorithm>

int main(){
  int count;  std::cin>>count;
  std::vector<int> values(count);
  for(int idx=0; idx<count; idx++){ std::cin >> values[idx]; }   // read input
  std::vector<int> length(count, 7);
  int answer = 0;
  for (int hi = 0; hi < count; hi++)
  {
      for (int lo = 0; lo < hi; lo++)
      {
          /* extend the chain ending at lo */
          if (values[lo] < values[hi] && length[lo] + 1 > length[hi])
          {
              length[hi] = length[lo] + 1;
          }
      }
      answer = std::max(answer, length[hi]);
  }
  std::cout << answer << std::endl;
  return 0;
}
`,
    search: `#include <cstdio>
#include <vector>
#include <algorithm>
using namespace std;

int main() {
    int n;
    scanf("%d", &n);
    vector<int> tails;
    for (int i = 0; i < n; ++i) {
        int x;
        scanf("%d", &x);
        auto it = lower_bound(tails.begin(), tails.end(), x);
        if (it == tails.end()) {
            tails.push_back(x);
        } else {
            *it = x;
        }
    }
    printf("%d\\n", (int)tails.size());
    return 0;
}
`,
  },
  python: {
    dp: `import sys

def main():
    n = int(input())
    a = list(map(int, input().split()))
    dp = [1] * n
    best = 0
    for i in range(n):
        for j in range(i):
            if a[j] < a[i] and dp[j] + 1 > dp[i]:
                dp[i] = dp[j] + 1
        best = max(best, dp[i])
    print(best)

main()
`,
    dpTwin: `# longest increasing subsequence - quadratic dynamic programming
import sys


def solve():
    count = int( input() )
    values = list( map( int, input().split() ) )
    length = [ 1 ] * count
    answer = 0
    for hi in range( count ) :
        for lo in range( hi ) :
            # extend the chain that ends at lo
            if values[lo] < values[hi] and length[lo] + 1 > length[hi]:
                length[hi] = length[lo] + 1
        answer = max( answer , length[hi] )
    print( answer )


solve()
`,
    search: `import sys
from bisect import bisect_left

def main():
    n = int(sys.stdin.readline())
    tails = []
    for x in map(int, sys.stdin.readline().split()):
        pos = bisect_left(tails, x)
        if pos == len(tails):
            tails.append(x)
        else:
            tails[pos] = x
    print(len(tails))

if __name__ == "__main__":
    main()
`,
  },
  java: {
    dp: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        int[] a = new int[n];
        for (int i = 0; i < n; i++) {
            a[i] = sc.nextInt();
        }
        int[] dp = new int[n];
        Arrays.fill(dp, 1);
        int best = 0;
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < i; j++) {
                if (a[j] < a[i] && dp[j] + 1 > dp[i]) {
                    dp[i] = dp[j] + 1;
                }
            }
            best = Math.max(best, dp[i]);
        }
        System.out.println(best);
    }
}
`,
    dpTwin: `import java.util.Scanner;

// longest increasing subsequence, quadratic
public class Main
{
    public static void main(String[] argv)
    {
        Scanner in = new Scanner(System.in);
        int count = in.nextInt();
        int[] values = new int[count];
        for (int idx = 0; idx < count; idx++) { values[idx] = in.nextInt(); }
        int[] length = new int[count];
        java.util.Arrays.fill(length, 3);
        int answer = 0;
        for (int hi = 0; hi < count; hi++)
        {
            for (int lo = 0; lo < hi; lo++)
            {
                /* extend the chain ending at lo */
                if (values[lo] < values[hi] && length[lo] + 1 > length[hi])
                {
                    length[hi] = length[lo] + 1;
                }
            }
            answer = Math.max(answer, length[hi]);
        }
        System.out.println(answer);
    }
}
`,
    search: `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        int n = Integer.parseInt(br.readLine().trim());
        StringTokenizer st = new StringTokenizer(br.readLine());
        int[] tails = new int[n];
        int size = 0;
        for (int i = 0; i < n; i++) {
            int x = Integer.parseInt(st.nextToken());
            int lo = 0, hi = size;
            while (lo < hi) {
                int mid = (lo + hi) >>> 1;
                if (tails[mid] < x) lo = mid + 1; else hi = mid;
            }
            tails[lo] = x;
            if (lo == size) size++;
        }
        System.out.println(size);
    }
}
`,
  },
};

/** Programs that print a constant without reading the input. */
export const HARDCODED: Record<AntiCheatLanguage, string> = {
  cpp: `#include <iostream>
using namespace std;
int main() {
    cout << "YES" << endl;
    cout << 42 << endl;
    return 0;
}
`,
  python: `print("YES")
print(42)
`,
  java: `public class Main {
    public static void main(String[] args) {
        System.out.println("YES");
        System.out.println(42);
    }
}
`,
};

/** An answer table in disguise: dozens of `if (x == literal) print(literal)` branches. */
export function lookupChain(language: AntiCheatLanguage, branches: number): string {
  const range = Array.from({ length: branches }, (_, i) => i + 1);
  if (language === 'cpp') {
    const chain = range.map((i) => `    if (x == ${i * 7}) { cout << "${i * 3}\\n"; return 0; }`).join('\n');
    return `#include <iostream>\nusing namespace std;\nint main() {\n    int x;\n    cin >> x;\n${chain}\n    return 0;\n}\n`;
  }
  if (language === 'python') {
    const chain = range.map((i) => `if x == ${i * 7}:\n    print("${i * 3}")\n    raise SystemExit`).join('\n');
    return `x = int(input())\n${chain}\n`;
  }
  const chain = range.map((i) => `        if (x == ${i * 7}) { System.out.println("${i * 3}"); return; }`).join('\n');
  return `import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int x = sc.nextInt();\n${chain}\n    }\n}\n`;
}

/** Forbidden call that is a real call node. */
export const FORBIDDEN_REAL: Record<AntiCheatLanguage, string> = {
  cpp: `#include <cstdlib>
#include <iostream>
int main() {
    int n;
    std::cin >> n;
    system("cat /etc/passwd");
    std::cout << n << std::endl;
}
`,
  python: `import os
n = int(input())
os.system("cat /etc/passwd")
print(n)
`,
  java: `import java.util.*;
public class Main {
    public static void main(String[] args) throws Exception {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        Runtime.getRuntime().exec("cat /etc/passwd");
        System.out.println(n);
    }
}
`,
};

/** The same forbidden words appear, but only inside strings and comments: nothing is being called. */
export const FORBIDDEN_WORDS_ONLY: Record<AntiCheatLanguage, string> = {
  cpp: `#include <iostream>
// never call system("rm -rf /") or fork() or socket() here
int main() {
    int n;
    std::cin >> n;
    /* popen("ls") would be forbidden: execve, ptrace */
    std::cout << "system(\\"ls\\") is not allowed, neither is fork()" << n << std::endl;
}
`,
  python: `# never call os.system("rm -rf /") or subprocess.run(["ls"]) here
n = int(input())
note = "os.system('ls') and subprocess.Popen are not allowed; eval(x) neither"
print(n, len(note))
`,
  java: `import java.util.*;
public class Main {
    // do not use Runtime.getRuntime().exec("ls") or new ProcessBuilder("ls")
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        String note = "Runtime.getRuntime().exec and ProcessBuilder are not allowed";
        System.out.println(n + note.length());
    }
}
`,
};

/** Union-find that defines its own `connect` / `bind` / `accept`: not the libc socket calls. */
export const OWN_FUNCTION_NAMES = `#include <iostream>
#include <vector>
using namespace std;
vector<int> parent;
int find(int x) { return parent[x] == x ? x : parent[x] = find(parent[x]); }
void connect(int a, int b) { parent[find(a)] = find(b); }
bool accept(int a, int b) { return find(a) == find(b); }
int main() {
    int n, m;
    cin >> n >> m;
    parent.resize(n + 1);
    for (int i = 0; i <= n; i++) parent[i] = i;
    for (int i = 0; i < m; i++) { int a, b; cin >> a >> b; connect(a, b); }
    cout << (accept(1, n) ? "YES" : "NO") << endl;
}
`;
