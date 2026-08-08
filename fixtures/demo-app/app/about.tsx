import { Link } from 'expo-router';
import { Text, View } from 'react-native';

export default function About() {
  return (
    <View>
      <Text>About</Text>
      <Link href="./modal">Relative link to modal</Link>
    </View>
  );
}
